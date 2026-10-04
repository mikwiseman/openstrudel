export const OPENAI_SIGN_IN_REQUIRED = "Вход в OpenAI больше не действует. Восстановите его в настройках основного Mac или сервера OpenStrudel. История сохранена; после входа повторите сообщение.";

export function isOpenAIAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unauthorized|\b401\b|invalid_grant|refresh_token_(?:expired|reused|invalidated)|authentication required|refresh token.{0,160}(?:expired|already used|revoked|invalidated)|(?:expired|revoked|invalid) access token/i.test(message);
}

export function openAILoginError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/address already in use|EADDRINUSE|port.*(?:busy|in use)/i.test(message)) {
    return "Другой вход в OpenAI уже открыт на этом Mac. Завершите или отмените его и попробуйте ещё раз.";
  }
  return "Не удалось завершить вход в OpenAI. Проверьте соединение и попробуйте ещё раз.";
}
