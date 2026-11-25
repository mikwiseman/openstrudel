import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { cloudStatus } from "../src/aigid-cloud-status.js";
const sha="a".repeat(40);
const config={repository:"example/guide",workflow:"Guide | TestFlight",appleAppId:"1234"};
const event={repository:{full_name:config.repository},sender:{id:84813463,login:"xcode-cloud[bot]"},context:config.workflow,state:"success",sha,
  target_url:"https://appstoreconnect.apple.com/teams/10000000-0000-4000-8000-000000000001/apps/1234/ci/builds/10000000-0000-4000-8000-000000000002"};
function signed(payload:unknown){const body=Buffer.from(JSON.stringify(payload));return {body,signature:"sha256="+createHmac("sha256","secret").update(body).digest("hex")};}
it("accepts only GitHub-signed final statuses from Apple's verified app for this release workflow",()=>{
  const {body,signature}=signed(event);
  expect(cloudStatus(config,"secret","status",body,signature)).toMatchObject({sha,success:true});
  expect(()=>cloudStatus(config,"secret","status",body,"sha256="+"b".repeat(64))).toThrow();
  for(const changed of [{sender:{id:1,login:"xcode-cloud[bot]"}},{context:"Other"},{state:"pending"},{target_url:"https://elsewhere.com/"},{repository:{full_name:"someone/repo"}}]){
    const {body,signature}=signed({...event,...changed});expect(cloudStatus(config,"secret","status",body,signature)).toBeNull();
  }
});
