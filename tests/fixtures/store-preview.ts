/** Isolated example content for public screenshots. Never loads personal data. */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenStrudelRuntime } from "../../src/runtime.js";
import { MockCodexEngine } from "../../src/codex.js";
import { createServer } from "node:http";

const output = resolve(process.argv[2]!);
const directory = await mkdtemp(join(tmpdir(), "strudel-store-preview-"));
process.chdir(directory);
process.env.OPENSTRUDEL_PORT = "0";
const runtime = new OpenStrudelRuntime({dbPath: ":memory:", engine: new MockCodexEngine(), rootDirectory: directory, startTelegram: false});
const signedIn = !process.argv.includes("--sign-in");
runtime.account.read = async () => ({ connected: signedIn, email: signedIn ? "you@example.com" : null, managed: true, planType: signedIn ? "plus" : null });
let loginStarts = 0;
if (!signedIn) {
  runtime.account.startLogin = async () => {
    loginStarts++;
    await new Promise(done => setTimeout(done, 1500));
    return {type: "device", loginId: "onboarding-test", verificationUrl: `http://127.0.0.1:${(control.address() as {port:number}).port}/auth`, userCode: "TEST-12345"};
  };
  runtime.account.status = async () => ({loginId: "onboarding-test", status: "pending"});
  runtime.account.cancel = async () => ({loginId: "onboarding-test", status: "canceled"});
}
// Disposable fixture only: use ephemeral ports and loopback, not production defaults.
Object.assign((runtime.api.mobile as any).options, { port: 0, host: "127.0.0.1", hostname: "127.0.0.1" });
const editor = runtime.store.createProfile({ name: "Редактор", instructions: "Пиши ясно и по делу. Сохраняй мой голос. Предлагай один сильный вариант и объясняй главную правку.", domain: "work" });
runtime.store.createProfile({ name: "Исследователь", instructions: "Находи первоисточники, сравнивай варианты и показывай, что проверено.", domain: "work" });
runtime.store.createProfile({ name: "Личный помощник", instructions: "Помогай держать важное под рукой. Спрашивай только то, без чего не обойтись.", domain: "personal" });
const conversation = runtime.store.profileConversation(editor.id);
runtime.store.importHistory(conversation.id, [
  {sourceId:"one",author:"Вы",date:"2026-10-02T06:40:00Z",direction:"inbound",text:"Помоги с анонсом новой мастерской. Хочу коротко, тепло и без рекламных клише."},
  {sourceId:"two",author:"Редактор",date:"2026-10-02T06:41:00Z",direction:"outbound",text:"## Место для ваших идей\n\nВ субботу открываем мастерскую. Приходите с идеей, которую давно откладывали, — вместе дадим ей форму.\n\n**10 октября · с 12:00 до 18:00**\n\nКофе, инструменты и любопытные люди уже будут. Осталось прийти.\n\n> Убрал обещания и оставил главное: что будет, когда и зачем приходить."},
]);
const primary=runtime.store.primaryConversation();
runtime.store.importHistory(primary.id,[{sourceId:"intro",author:"OpenStrudel",date:"2026-10-02T06:39:00Z",direction:"outbound",text:"Давайте начнём. Что хотите сделать?"}]);
await runtime.start();
const control=createServer(async(req,res)=>{
  res.setHeader("content-type","application/json");
  if(req.url==="/invite") {const invitation=await runtime.api.mobile.invite(true);const url=new URL(invitation.url);url.searchParams.set("name","Мой Mac");res.end(JSON.stringify({...invitation,url:url.toString()}));return;}
  res.end(JSON.stringify({editor:editor.id, loginStarts}));
});
await new Promise<void>(done=>control.listen(0,"127.0.0.1",done));
await writeFile(output,JSON.stringify({url:`http://127.0.0.1:${(control.address() as {port:number}).port}`,editor:editor.id}),{mode:0o600});
console.log("Private screenshot fixture ready; example content only.");
const stop=async()=>{control.close();await runtime.stop();await rm(directory,{recursive:true,force:true});process.exit(0);};
process.once("SIGTERM",stop);process.once("SIGINT",stop);
