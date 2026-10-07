import { expect,it } from "vitest";
import { telegramMcpConfig } from "../src/telegram-mcp.js";
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
