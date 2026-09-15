import { defineService, type Context } from "@earendil-works/chord";
export interface PasswordService {
  authorize(title: string, context: Context): Promise<boolean>;
}
export const PasswordPrompt = defineService<PasswordService>("study.password.v1");
