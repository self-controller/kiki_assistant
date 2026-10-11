// Loads server/.env when present. Import this before anything that reads process.env.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on the real environment (e.g. Docker).
}
