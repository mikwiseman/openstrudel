import { expect,it } from "vitest";
import { telegramMcpConfig } from "../src/telegram-mcp.js";
import { contextServers } from "../src/claude.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const servers={company:{url:"https://example.test/mcp",http_headers:{Authorization:"Bearer fixture", "X-Hermes-User-Id":"owner", "x-hermes-chat-id":"owner"}}};
it("replaces legacy owner identity with the verified group sender",()=>{
 const value=telegramMcpConfig(servers,{userId:"42",chatId:"-100",messageId:"-100:7"},"conversation")["mcp_servers.company"];
 expect(value).toEqual({url:servers.company.url,enabled:true,http_headers:{Authorization:"Bearer fixture","x-hermes-platform":"telegram","x-hermes-user-id":"42","x-hermes-chat-id":"-100","x-hermes-message-id":"-100:7","x-hermes-session-id":"openstrudel:conversation"}});
});
it("disables channel services for UI and scheduled turns without verified identity",()=>{
 expect(telegramMcpConfig(servers,undefined)["mcp_servers.company"]).toMatchObject({enabled:false,http_headers:{Authorization:"Bearer fixture"}});
 expect(telegramMcpConfig(servers,{userId:"owner",chatId:"-100",messageId:"7"})["mcp_servers.company"]).toMatchObject({enabled:false});
});
it("rejects plaintext and credential-bearing service endpoints",()=>{
 for(const url of ["http://example.test/mcp","https://user:password@example.test/mcp"]) expect(()=>telegramMcpConfig({company:{url}},undefined)).toThrow();
});

it("offers an approved group's named tools only on an admitted Telegram turn", () => {
 const service = { company: { url: servers.company.url, approvedTools: ["ledger_lookup"], allowedSenders:["42"] } };
 const actor = {userId:"42",chatId:"-100",messageId:"7"};
 const grant = (access?:boolean) => telegramMcpConfig(service,actor,"conversation",access)["mcp_servers.company"];
 expect(grant(true)).toMatchObject({ enabled:true, enabled_tools:["ledger_lookup"] });
 expect(grant(false)).toMatchObject({ enabled:false });
 expect(grant()).toMatchObject({ enabled:false });
 expect(telegramMcpConfig(service,{...actor,userId:"43"},"conversation",true)["mcp_servers.company"]).toMatchObject({enabled:false,http_headers:{}});
 expect(telegramMcpConfig(service,undefined,"conversation",true)["mcp_servers.company"]).toMatchObject({enabled:false});
 const root = mkdtempSync(join(tmpdir(),"group-tools-"));
 try {
   const dir = join(root,".data/connections");
   mkdirSync(dir,{recursive:true});
   writeFileSync(join(dir,"group.approved-telegram.json"),JSON.stringify(service));
   expect(contextServers(root,"group",{telegramActor:actor,access:true}).company).toMatchObject({toolLists:{enabled:["ledger_lookup"]}});
   expect(contextServers(root,"group",{telegramActor:actor,access:false})).toEqual({});
   writeFileSync(join(dir,"group.approved-telegram.json"),JSON.stringify({company:{url:servers.company.url}}));
   expect(() => contextServers(root,"group",{telegramActor:actor,access:true})).toThrow();
 } finally { rmSync(root,{recursive:true,force:true}); }
});
