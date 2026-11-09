// Ignores SIGTERM and stays alive until SIGKILL (the M-join control child).
process.on('SIGTERM', () => process.stdout.write('ignored SIGTERM\n'))
process.stdout.write('ready\n')
setInterval(() => {}, 1000)
