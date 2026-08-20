/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Versienummer van deze build, zichtbaar in de kop van /backend. Bewust
  // hier en op één plek: zo kan je in één oogopslag zien welke versie er
  // effectief op Vercel draait. Zonder dat is "het werkt niet" niet te
  // onderscheiden van "de nieuwe versie staat er nog niet op" (aug 2026).
  // BIJ ELKE NIEUWE VERSIE HIER OPHOGEN.
  env: { APP_VERSIE: "58" },
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
