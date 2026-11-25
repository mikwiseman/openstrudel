import { projectUsesRussian } from "./project-language.js";
import type { BuildRequest } from "./aigid-queue.js";
import { telegramText } from "./telegram-format.js";
import type { TelegramLinkButton } from "./types.js";

export interface BuildReply { title: string; body?: string; actions: TelegramLinkButton[]; russian: boolean }

function projectName(repository: string | null) {
  const slug = repository?.split("/")[1] ?? "ai-gid";
  const brands: Record<string,string> = {"ai-gid":"AiGid",openramble:"OpenRamble","openramble-site":"OpenRamble",openstrudel:"OpenStrudel",openaccs:"OpenAccs",waiwai:"WaiWai"};
  return brands[slug.toLowerCase()] ?? slug.replace(/[-_]+/g," ").replace(/^./u,c=>c.toUpperCase());
}

function link(value: string): URL | undefined {
  try {
    const result = new URL(value);
    if (result.protocol === "https:" && !result.username && !result.password && !result.port) return result;
  } catch { /* Plain text from the build log. */ }
}

type Translate = (en:string,ru:string)=>string;

/** Only known worker and provider receipts become chat copy. Diagnostics can contain private source, paths and credentials. */
function failureReason(detail: string, t: Translate): string {
  const worker = detail.replace(/^Project worker: (?:Wolf project runner: )?/u, "");
  if (/^(?:The configured ChatGPT subscription is unavailable|Worker subscription unavailable|Codex did not confirm the configured ChatGPT account|The release subscription changed|Sign in with ChatGPT on the build server)[.!]?$/u.test(worker))
    return t("The worker couldn’t authenticate with ChatGPT. Reconnect its Codex subscription and retry.", "Сервер сборки не смог войти в ChatGPT. Подключите подписку Codex на сервере и повторите запрос.");
  if (worker === "refresh_token_expired" || worker === "refresh_token_reused")
    return t("The worker’s ChatGPT session ended. Sign in again on the build server and retry.", "Сессия ChatGPT завершилась. Войдите в Codex на сервере сборки и повторите запрос.");
  if (/^The worker did not confirm (?:the requested Codex model|the requested Codex reasoning level|Standard speed)\.$/u.test(worker))
    return t("The worker couldn’t verify the requested Codex settings. Check the worker’s model configuration and retry.", "Сервер не подтвердил настройки Codex. Проверьте выбранную модель, режим и уровень рассуждения, затем повторите запрос.");
  if (worker.startsWith("Command: ")) {
    const code=worker.match(/^(?:Exit code: )([1-9]\d{0,2})$/mu)?.[1];
    if (code && /^Command: python3? -m py_compile /u.test(worker) && /^Diagnostic: \[Errno 2\] No such file or directory/mu.test(worker))
      return t("The Python syntax check couldn’t find its input file. Check the file path and retry.", "Проверка синтаксиса Python не нашла входной файл. Проверьте путь и повторите сборку.");
    if (code) return t("A project check exited with code "+code+". Fix the failing check and retry.", "Проверка проекта завершилась с кодом "+code+". Исправьте ошибку проверки и повторите сборку.");
  }
  if (worker === "The source change did not complete. There is no changed revision to package.")
    return t("The source change didn’t finish. Complete it before requesting another package.", "Изменение кода не завершилось. Завершите его и запросите сборку ещё раз.");
  if (/^(?:Incomplete worker report\.|Unexpected token .+is not valid JSON)/u.test(worker))
    return t("The worker returned an unreadable result. Check its run before retrying.", "Сервер вернул результат в неверном формате. Проверьте запуск перед повторной попыткой.");
  if (worker === "The worker could not fetch the requested Git revision.")
    return t("The worker couldn’t fetch the requested revision. Check repository access and retry.", "Сервер не смог получить нужную версию кода. Проверьте доступ к репозиторию и повторите запрос.");
  const first = detail.split("\n",1)[0];
  if (first === "GitHub Pages reported a deployment failure.") return t("GitHub Pages failed to deploy the site. Check the Pages run in GitHub Actions.", "GitHub Pages не опубликовал сайт. Откройте запуск Pages в GitHub Actions.");
  if (first === "Vercel reported a production deployment failure.") return t("Vercel’s production deployment failed. Check the deployment log in Vercel.", "Публикация в Vercel завершилась ошибкой. Откройте журнал публикации в Vercel.");
  if (first === "The project’s deployment workflow reported a failure." || first?.startsWith("GitHub completed the deployment workflow with result "))
    return t("The deployment workflow didn’t finish successfully. Check the failed step in GitHub.", "Публикация не завершилась успешно. Откройте журнал этапов в GitHub.");
  return t("The report didn’t identify the failed step. Check the project’s run history before retrying.", "По отчёту не удалось определить этап сбоя. Проверьте историю запусков проекта перед повторной попыткой.");
}

/** Job details keep the original provider receipt. Only named delivery fields become actions. */
export function buildReply(job: BuildRequest, request: string): BuildReply | null {
  if (!["completed", "failed", "dispatched"].includes(job.state)) return null;
  const russian = projectUsesRussian(request);
  const t = (en:string,ru:string)=>russian ? ru : en;
  const name = projectName(job.repository);
  const lines = (job.detail ?? "").split("\n");
  const urls = lines.flatMap(line=>link(line.trim()) ?? []);
  const github = (url:URL) => url.origin === "https://github.com" && url.pathname.startsWith("/"+job.repository+"/");
  const uuid="[a-f\\d]{8}-(?:[a-f\\d]{4}-){3}[a-f\\d]{12}";
  const applePath=new RegExp("^/teams/"+uuid+"/apps/(\\d+)/ci/builds/"+uuid+"$","i");
  const apple = urls.find(url=>url.origin==="https://appstoreconnect.apple.com" && !url.search && !url.hash && applePath.test(url.pathname));
  const action = (text:string,url?:URL):TelegramLinkButton[]=>url ? [{text,url:url.href}] : [];
  const result = (title:string,actions:TelegramLinkButton[]=[],body?:string):BuildReply=>({title,actions,russian,...(body ? {body} : {})});
  if (job.state === "dispatched") {
    return job.repository
      ? result(t(name+" was submitted for deployment.", name+" передан на развёртывание."))
      : result(t("AiGid was submitted to Xcode Cloud.", "AiGid передан на сборку в Xcode Cloud."));
  }
  if (job.state === "failed") {
    if (!job.repository && lines[0] === "Apple reported a TestFlight workflow failure.")
      return result(t("AiGid’s Xcode Cloud workflow failed.", "Сбой сборки AiGid в Xcode Cloud."),
        action(t("View build log","Открыть журнал"),apple),
        t("Check the failed action in Xcode Cloud. The workflow status doesn’t confirm whether a build was uploaded.", "Откройте этап с ошибкой в Xcode Cloud. Статус запуска не показывает, была ли сборка загружена."));
    const buildLog=urls.find(url=>github(url) && !url.search && !url.hash && /\/(?:actions\/runs\/\d+|pull\/\d+|commit\/[a-f\d]{40})$/iu.test(url.pathname));
    return result(t(name+" run stopped.", "Запуск "+name+" остановлен."),action(t("View run","Открыть запуск"),buildLog),failureReason(job.detail ?? "",t));
  }
  if (!job.repository) {
    const invite=urls.find(url=>url.origin==="https://testflight.apple.com" && !url.search && !url.hash && /^\/join\/[A-Za-z0-9]+\/?$/.test(url.pathname));
    const appId=apple && applePath.exec(apple.pathname)?.[1];
    const links=appId ? [...action(t("Open TestFlight","Открыть TestFlight"),new URL("https://testflight.apple.com/v1/app/"+appId)),
      ...action(t("Build details","Детали сборки"),apple)] : action(t("Join public beta","Вступить в публичную бету"),invite);
    return result(t("AiGid finished building in Xcode Cloud.","Сборка AiGid завершена в Xcode Cloud."),links,
      t("In TestFlight, open AiGid and tap Update when it appears.", "В TestFlight откройте AiGid и нажмите «Обновить», когда появится кнопка."));
  }
  if (job.package_target) {
    const target=job.package_target;
    const platforms=target==="desktop" ? ["Windows","Linux"] : [target==="macos" ? "macOS" : target==="android" ? "Android" : "web"];
    const actions:TelegramLinkButton[]=[];
    // Each artifact receipt contains name, URL, then verified checksum in that order.
    for (const platform of platforms) {
      const index=lines.findIndex((line,i)=>line.includes(" · ") && (target!=="desktop" || line.toLowerCase().includes("-"+platform.toLowerCase()+"-"))
        && /^SHA-256 [a-f0-9]{64}$/.test(lines[i+2] ?? ""));
      const url=index<0 ? undefined : link(lines[index+1] ?? "");
      const cloud=target==="desktop" || target==="macos";
      if (!url || (cloud && !(github(url) && /\/actions\/runs\/\d+\/artifacts\/\d+$/.test(url.pathname)))) continue;
      const label=platform==="Android" ? t("Download APK","Скачать APK") : platform==="web" ? t("Download ZIP","Скачать ZIP") :
        target==="macos" ? t("Download for Mac","Скачать для Mac") : platform;
      actions.push(...action(label,url));
    }
    if (actions.length!==platforms.length) return result(t("The "+name+" build finished.", "Сборка "+name+" завершена."),actions,
      t("I couldn’t verify every download link.","Не удалось подтвердить все ссылки для скачивания."));
    if (target==="web") return result(t(name+" is ready to download.", "Сайт "+name+" готов к скачиванию."),actions);
    return result(target==="desktop" ? t(name+" installers are ready.","Установщики "+name+" готовы.") :
      t(name+" "+platforms[0]+" build is ready.","Сборка "+name+" для "+platforms[0]+" готова."),actions);
  }
  if (job.release_project===2)
    return result(t(name+" changes are merged.","Изменения в "+name+" объединены."),action(t("View change","Открыть изменение"),urls.find(github)));
  if (job.release_project===1) {
    const site=urls.find(url=>!github(url));
    if (site) return result(t(name+" is live.",name+" опубликован."),action(t("Open website","Открыть сайт"),site));
    return result(t(name+" deployment finished.","Развёртывание "+name+" завершено."),action(t("View deployment","Открыть результат"),urls.find(github)));
  }
  const pr=job.pull ? new URL("https://github.com/"+job.repository+"/pull/"+job.pull) : undefined;
  if (job.changes) return result(t(name+" changes are ready for review.","Изменения в "+name+" готовы к проверке."),
    action(t("Review changes","Посмотреть изменения"),pr),job.notes ?? undefined);
  return result("",[],job.notes || job.detail || t("Finished checking "+name+".","Проверка "+name+" завершена."));
}

function markdown(reply: BuildReply) {
  return [reply.title && "**"+reply.title+"**",reply.body].filter(Boolean).join("\n\n");
}
export function nativeBuildReply(reply: BuildReply) {
  const links=reply.actions.map(a=>"["+a.text+"]("+a.url.replaceAll("(", "%28").replaceAll(")", "%29")+")").join(" · ");
  return [markdown(reply),links].filter(Boolean).join("\n\n");
}
export function telegramBuildReply(reply: BuildReply) {
  return telegramText(markdown(reply));
}
