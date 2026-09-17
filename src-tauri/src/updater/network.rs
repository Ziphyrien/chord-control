use futures_util::{stream::FuturesUnordered, StreamExt};
use reqwest::{Client, Url};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

const PROBE_BYTES: usize = 64 * 1024;
const MAX_INSTALLER: u64 = 150 * 1024 * 1024;

fn sources(address: &Url) -> Vec<Url> {
    let mut urls = vec![address.clone()];
    let parts: Vec<_> = address.path().split('/').skip(1).collect();
    let public_release = address.scheme() == "https"
        && address.host_str() == Some("github.com")
        && address.username().is_empty()
        && address.password().is_none()
        && address.port().is_none()
        && address.query().is_none()
        && address.fragment().is_none()
        && parts.iter().all(|part| !part.is_empty())
        && ((parts.len() == 6 && parts[2] == "releases" && parts[3] == "download")
            || (parts.len() == 6 && parts[2..5] == ["releases", "latest", "download"]));
    if public_release {
        let mirrors: Vec<String> =
            serde_json::from_str(include_str!("../../../shared/github-mirrors.json"))
                .expect("Invalid bundled GitHub mirrors");
        urls.extend(
            mirrors
                .iter()
                .filter_map(|prefix| Url::parse(&format!("{prefix}{address}")).ok()),
        );
    }
    urls
}

pub(super) async fn check(app: &AppHandle) -> Result<Option<Update>, String> {
    let endpoints: Vec<Url> = serde_json::from_value(
        app.config()
            .plugins
            .0
            .get("updater")
            .ok_or("缺少更新配置")?["endpoints"]
            .clone(),
    )
    .map_err(|e| e.to_string())?;
    let mut checks = FuturesUnordered::new();
    for endpoint in endpoints.iter().flat_map(sources) {
        let updater = app
            .updater_builder()
            .endpoints(vec![endpoint.clone()])
            .map_err(|e| e.to_string())?
            .timeout(Duration::from_secs(12))
            .configure_client(|client| {
                client
                    .https_only(true)
                    .connect_timeout(Duration::from_secs(5))
            })
            .build()
            .map_err(|e| e.to_string())?;
        checks.push(async move {
            let result = tokio::time::timeout(Duration::from_secs(15), updater.check())
                .await
                .map_err(|_| "来源检查超时".to_owned())?
                .map_err(|e| e.to_string());
            result.map_err(|error| format!("{}: {error}", endpoint.host_str().unwrap_or("direct")))
        });
    }
    let mut errors = Vec::new();
    while let Some(result) = checks.next().await {
        match result {
            Ok(update) => return Ok(update), // Dropping the other futures cancels their requests.
            Err(error) => errors.push(error),
        }
    }
    Err(format!("检查主程序更新失败: {}", errors.join("; ")))
}

async fn probe(client: &Client, url: &Url) -> Result<(), String> {
    let mut response = client
        .get(url.clone())
        .header("Range", "bytes=0-65535")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !matches!(response.status().as_u16(), 200 | 206)
        || response
            .content_length()
            .is_some_and(|size| size > MAX_INSTALLER)
        || response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().contains("text/html"))
    {
        return Err("来源未返回安装包".into());
    }
    let mut received = 0;
    let mut prefix = Vec::<u8>::new();
    while received < PROBE_BYTES {
        let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? else {
            break;
        };
        if prefix.len() < 2 {
            prefix.extend(chunk.iter().take(2 - prefix.len()));
        }
        received += chunk.len();
        if prefix.len() == 2 && prefix != b"MZ" {
            return Err("来源未返回 Windows 安装包".into());
        }
    }
    if prefix != b"MZ" {
        return Err("安装包为空或不完整".into());
    }
    Ok(())
}

pub(super) async fn download(update: &Update) -> Result<Vec<u8>, String> {
    let client = Client::builder()
        .https_only(true)
        .user_agent("chord-control")
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let mut remaining = sources(&update.download_url);
    let mut errors = Vec::new();
    while !remaining.is_empty() {
        let mut probes: FuturesUnordered<_> = remaining
            .iter()
            .cloned()
            .map(|url| {
                let client = &client;
                async move {
                    let result = probe(client, &url).await;
                    (url, result)
                }
            })
            .collect();
        let mut winner = None;
        while let Some((url, result)) = probes.next().await {
            match result {
                Ok(()) => {
                    winner = Some(url);
                    break;
                }
                Err(error) => {
                    errors.push(format!("{}: {error}", url.host_str().unwrap_or("direct")));
                    remaining.retain(|candidate| candidate != &url);
                }
            }
        }
        drop(probes);
        let Some(url) = winner else { break };
        remaining.retain(|candidate| candidate != &url);
        let mut candidate = update.clone();
        candidate.download_url = url;
        candidate.timeout = Some(Duration::from_secs(90));
        // Only the winning route downloads the full file. Tauri verifies the embedded key.
        let exceeded = std::sync::atomic::AtomicBool::new(false);
        let mut size = 0usize;
        let mut transfer = Box::pin(candidate.download(
            |chunk, total| {
                size = size.saturating_add(chunk);
                if size as u64 > MAX_INSTALLER || total.is_some_and(|n| n > MAX_INSTALLER) {
                    exceeded.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            },
            || {},
        ));
        let result = futures_util::future::poll_fn(|cx| {
            use std::future::Future;
            let result = transfer.as_mut().poll(cx);
            if exceeded.load(std::sync::atomic::Ordering::Relaxed) {
                std::task::Poll::Ready(Err("安装包超过大小限制".to_owned()))
            } else {
                result.map(|value| value.map_err(|e| e.to_string()))
            }
        });
        match result.await {
            Ok(bytes) => return Ok(bytes),
            Err(error) => errors.push(error),
        }
    }
    Err(format!("下载主程序更新失败: {}", errors.join("; ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mirrors_only_receive_public_release_urls() {
        for address in [
            "https://github.com/a/b/releases/latest/download/latest.json",
            "https://github.com/a/b/releases/download/app-v1/setup.exe",
        ] {
            assert_eq!(sources(&Url::parse(address).unwrap()).len(), 4);
        }
        for address in [
            "https://example.org/setup.exe",
            "https://github.com/a/b/releases/download/v1/a?token=secret",
            "https://user:secret@github.com/a/b/releases/download/v1/a",
            "http://github.com/a/b/releases/download/v1/a",
            "https://github.com.evil.test/a/b/releases/download/v1/a",
            "https://github.com/a/b/releases/download/v1/a#secret",
        ] {
            let url = Url::parse(address).unwrap();
            assert_eq!(sources(&url), vec![url]);
        }
    }
}
