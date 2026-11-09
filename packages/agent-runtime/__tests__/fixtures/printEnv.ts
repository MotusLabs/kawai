// Prints its environment and cwd as one JSON line, then exits.
process.stdout.write(`${JSON.stringify({ env: process.env, cwd: process.cwd() })}\n`)
