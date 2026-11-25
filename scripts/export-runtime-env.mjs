// Invoked with Node's --env-file. macOS launchd shells may not be allowed to
// source a configuration under Documents even when the Node runtime can read it.
// Emit shell-quoted exports into command substitution, never into service logs.
const allowed = /^(?:WORKBUDDY_QQ_[A-Z0-9_]+|ONEBOT_[A-Z0-9_]+|WB_[A-Z0-9_]+)$/;
for (const [name, value] of Object.entries(process.env)) {
  if (!allowed.test(name)) continue;
  const quoted = "'" + value.replaceAll("'", "'\\''") + "'";
  process.stdout.write(`export ${name}=${quoted}\n`);
}
