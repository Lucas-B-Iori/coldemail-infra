module.exports = {
  apps: [
    {
      name: 'coldmail-engine',
      script: 'src/cli.ts',
      args: 'run',
      node_args: '--disable-warning=ExperimentalWarning',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '350M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
