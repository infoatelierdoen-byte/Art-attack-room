import { Html, Head, Main, NextScript } from "next/document";

// Lettertype Quicksand (Google Fonts) — hier geladen i.p.v. via next/font, om
// dit project simpel en makkelijk aanpasbaar te houden (gewoon een <link>,
// geen extra build-afhankelijkheid). Zie styles/globals.css voor waar het
// effectief toegepast wordt (body { font-family: ... }).
export default function Document() {
  return (
    <Html lang="nl">
      <Head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
