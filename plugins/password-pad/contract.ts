import { defineService, type Context } from "@earendil-works/chord";

/** Consumers request an authorization decision; the provider owns all challenge state. */
export type PasswordService = {
  authorize(title: string, context: Context): Promise<boolean>;
};

export const PasswordPrompt = defineService<PasswordService>("study.password.v1");
