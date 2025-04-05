module.exports = {
    apps: [
      {
        name: "backend-tirepro",
        script: "dist/main.js",
        env: {
          NODE_ENV: "production",
          PORT: 6001,
          AWS_BUCKET_NAME: "tireproimages",
          AWS_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: "your_key",
          AWS_SECRET_ACCESS_KEY: "your_secret",
          // other env variables...
        },
      },
    ],
  };
  