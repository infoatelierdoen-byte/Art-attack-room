/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // De widget wordt via een Wix HTML-embed (iframe) getoond — X-Frame-Options
  // moet dus NIET op DENY/SAMEORIGIN staan voor de /widget route.
  async headers() {
    return [
      {
        source: "/widget",
        headers: [{ key: "X-Frame-Options", value: "ALLOWALL" }]
      }
    ];
  }
};

module.exports = nextConfig;
