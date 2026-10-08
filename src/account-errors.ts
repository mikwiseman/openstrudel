import { HomeError } from "./home.js";

export const OPENAI_SIGN_IN_REQUIRED = "Войдите в OpenAI на устройстве сотрудника: OpenStrudel → Настройки → Аккаунты. История сохранена; после входа повторите сообщение.";

export class AccountUnavailableError extends HomeError {
  constructor(readonly reason: "sign_in_required" | "limits" | "login_pending" | "unavailable") {
    super({
      sign_in_required: OPENAI_SIGN_IN_REQUIRED,
      limits: "Лимит подключённых аккаунтов OpenAI закончился. Дождитесь обновления лимита или выберите другой аккаунт в OpenStrudel → Настройки → Аккаунты.",
      login_pending: "Завершите вход в OpenAI в OpenStrudel → Настройки → Аккаунты, затем повторите сообщение.",
      unavailable: "OpenAI пока не отвечает. Аккаунт сохранён, повторный вход не нужен. Попробуйте позже.",
    }[reason], reason === "unavailable" ? 503 : 409);
  }
}

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
