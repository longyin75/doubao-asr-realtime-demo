module.exports = {
  apps: [
    {
      name: 'doubao-asr-cloud',
      script: 'server-cloud/index.js',
      cwd: '/root/doubao-asr-cloud',
      env: {
        NODE_ENV: 'production',
        CLOUD_PORT: 3001,
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: '/root/doubao-asr-cloud/logs/error.log',
      out_file: '/root/doubao-asr-cloud/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
