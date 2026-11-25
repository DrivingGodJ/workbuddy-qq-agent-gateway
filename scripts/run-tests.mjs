import { spawn } from "node:child_process";
// Offline tests use synthetic identities, never the live bot's account.
const child = spawn(process.execPath, ["--test", ...process.argv.slice(2)], {
  stdio: "inherit", env: { ...process.env,
    WORKBUDDY_QQ_OWNER_QQ_ID: "100000001",
    WORKBUDDY_QQ_BOT_QQ_ID: "100000002" }
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
