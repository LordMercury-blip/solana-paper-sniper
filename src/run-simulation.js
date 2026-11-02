// Entry point for the offline mock-feed simulation.
//   node src/run-simulation.js --help
import { runCli } from './cli.js';

process.exitCode = runCli(process.argv.slice(2));