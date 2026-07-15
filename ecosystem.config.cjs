module.exports = {
  apps: [
    {
      name: "observer-api",
      script: "dist/server/index.js",
      node_args: "--max-old-space-size=2048",
      cwd: "./",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "2G",
      env: {
        NODE_ENV: "production",
      },
      error_file: ".data/logs/pm2-api-error.log",
      out_file: ".data/logs/pm2-api-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
    {
      name: "observer-ocr",
      script: "paddle_ocr_service/ocr_server.py",
      interpreter: "python",
      cwd: "./",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        OCR_HOST: "127.0.0.1",
        OCR_PORT: "9003",
      },
      error_file: ".data/logs/pm2-ocr-error.log",
      out_file: ".data/logs/pm2-ocr-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
  ],
};
