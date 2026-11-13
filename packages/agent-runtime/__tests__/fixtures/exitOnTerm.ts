// Exits with code 7 shortly after SIGTERM; echoes stdin lines meanwhile.
process.on('SIGTERM', () => setTimeout(() => process.exit(7), 50))
process.stdin.on('data', (chunk) => process.stdout.write(`echo:${chunk.toString()}`))
process.stdout.write('ready\n')
setInterval(() => {}, 1000)
