import type { BuilderTask } from "./index.js";

/** Pull request 176: the native app words a failure's cause in its own language and shows a group's switches.
 * Graded by the app's own unit tests through the repository's build wrapper, which takes a native build: run with --native. */
export default {
  id: "b176-cause-words", pattern: "builder-fix", pr: 176,
  title: "The native app says a failure's cause in the interface language and gives a Telegram group its switches.",
  base: "6808160db87aeb3fe022f0f68e33855c65e32612", fix: "27c99c53c12ab2df9f16e66ba0084c1300b9b2c5",
  statement: `Two problems in the native app (macOS and iOS, under native/OpenStrudel), reported by a person who uses it in English.

1. When an employee's schedule fails, the app shows the Home's own Russian sentence ("Войдите в OpenAI на устройстве сотрудника: …") on an English screen. The Home now sends the cause of a failure as a code beside the reason. The app must say a cause it knows in the interface's own language and never show the Home's sentence for it.

2. A Telegram group now has two more switches on its Home, posted transcripts and when the group is answered, but the app offers only its pause button.

What must be true afterwards:
- A failure read from a Home carries an optional code: TeamFailures.Failure(since:reason:code:), nil for a Home that names none.
- TeamWords gets cause(_ code: String?) -> String?. It returns short words for "sign_in", "limit" and "connection" in every interface language, and nil for any other code, an unknown one and none. In Russian: «Нужен вход в аккаунт модели», «Закончился лимит модели», «Нет связи с моделью». In English: "Needs a model sign-in", "Model limit reached", "No connection to the model".
- TeamWords.failure(since:reason:code:now:) keeps since when. A named cause replaces the Home's sentence: «Не получается с 07:15: нужен вход в аккаунт модели.», in English "Not working since <time>: needs a model sign-in." A code without short words leaves the time alone: «Не получается с 07:15.» Only a Home that names no cause is quoted: «Не получается с 07:15: » followed by its reason. With no since the line stays «Последний запуск не получился.»
- NeedsYou.failing(_:failure:words:now:) for a named cause has the cause as its title («Нужен вход в аккаунт модели», "Needs a model sign-in") and «Не получается с 07:15.» as its text, with the same card id as before. A code without short words gives the title «Не получается с 07:15» and no text.
- A group read from a Home has optional transcripts ("on" or "off") and replies ("instructions" or "mentions"); both are nil for a Home that does not send them. HomeClient gets setTelegramGroupTranscripts(_ chatId: String, posted: Bool) and setTelegramGroupReplies(_ chatId: String, mentionsOnly: Bool). Each sends one PATCH to /v1/integrations/telegram/chats/<chatId> with only its own field, {"transcripts": Bool} or {"replies": "mentions" | "all"}, as setTelegramGroupEnabled sends only {"enabled": Bool}, and the client then shows what the Home answered.
- The new words are in public/localizations.json for every interface language.

Existing behaviour and the existing tests must keep working.`,
  runner: "xcodebuild",
  hidden_tests: ["native/OpenStrudel/Tests/DeviceLibraryTests.swift", "native/OpenStrudel/Tests/NeedsYouTests.swift", "native/OpenStrudel/Tests/TeamTests.swift",
    "native/OpenStrudel/UITests/ReleaseScenariosUITests.swift", "native/OpenStrudel/UITests/TeamUITests.swift", "tests/fixtures/team.ts"],
  fail_to_pass: ["aGroupsSwitchesAreChangedOneAtATimeAndReadBackFromItsHome", "aFailingEmployeeIsACardThatSaysWhyAndSinceWhen", "aCauseTheHomeNamesIsSaidInTheInterfaceLanguageNeverInTheHomesSentence", "aFailingEmployeeSaysWhyWhenItsHomeTells"],
  pass_to_pass: [],
  native: { scheme: "OpenStrudel macOS", only: ["OpenStrudel Text Tests/DeviceManagementTests", "OpenStrudel Text Tests/NeedsYouTests", "OpenStrudel Text Tests/TeamTests"] },
  reference_message: "Fixed: the app words a named cause of a failure in its own language, and a group's transcripts and reply mode can be changed from its menu. The unit tests pass.",
} satisfies BuilderTask;
