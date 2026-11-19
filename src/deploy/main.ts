#!/usr/bin/env node
// Runs deploy and doctor on their own: node dist/deploy/main.js deploy|doctor [options]
import { deployHelp, doctorHelp, runDeploy, runDoctor } from "./index.js";

const [command, ...args] = process.argv.slice(2);
if (command === "deploy" || command === "doctor") process.exitCode = await (command === "deploy" ? runDeploy : runDoctor)(args);
else { process.stderr.write(deployHelp + doctorHelp); process.exitCode = 1; }
