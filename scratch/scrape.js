const fs = require('fs');
const path = require('path');

const pages = [
  { url: 'https://awakeniq.com/about-us/', filename: 'initial_about_us.html' },
  { url: 'https://awakeniq.com/services/', filename: 'initial_services.html' },
  { url: 'https://awakeniq.com/single-class/', filename: 'initial_single-class.html' },
  { url: 'https://awakeniq.com/dmit/', filename: 'initial_dmit.html' },
  { url: 'https://awakeniq.com/qsr/', filename: 'initial_qsr.html' },
  { url: 'https://awakeniq.com/cosmic-healing/', filename: 'initial_cosmic-healing.html' },
  { url: 'https://awakeniq.com/gallery/', filename: 'initial_gallery.html' },
  { url: 'https://awakeniq.com/testimonials/', filename: 'initial_testimonials.html' },
  { url: 'https://awakeniq.com/blog/', filename: 'initial_blog.html' },
  { url: 'https://awakeniq.com/contact-us/', filename: 'initial_contact-us.html' },
  { url: 'https://awakeniq.com/', filename: 'initial_index.html' } // initial_index.html is last so it doesn't match and prefix-replace other URLs
];

const outputDir = path.join(__dirname, '../frontend');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

function rewriteAssetsAndLinks(html) {
  // 1. First, replace all specific subpages (excluding the homepage URL)
  // We sort them longest first so subpages match before parents
  const specificPages = pages.filter(p => p.url !== 'https://awakeniq.com/');
  const sortedSpecific = [...specificPages].sort((a, b) => b.url.length - a.url.length);

  for (const p of sortedSpecific) {
    // Replace absolute URLs
    const absUrlRegex = new RegExp(p.url.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
    html = html.replace(absUrlRegex, p.filename);

    // Replace absolute URLs without trailing slash
    if (p.url.endsWith('/')) {
      const urlWithoutSlash = p.url.slice(0, -1);
      const absUrlNoSlashRegex = new RegExp(urlWithoutSlash.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '(?=["\'/\\s])', 'g');
      html = html.replace(absUrlNoSlashRegex, p.filename);
    }

    // Replace domain-relative paths
    const parsed = new URL(p.url);
    if (parsed.pathname !== '/') {
      const pathname = parsed.pathname;
      const relativeRegex = new RegExp('href=["\']' + pathname.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '["\']', 'g');
      html = html.replace(relativeRegex, `href="${p.filename}"`);

      // Without trailing slash in relative path
      if (pathname.endsWith('/')) {
        const pathnameNoSlash = pathname.slice(0, -1);
        const relativeNoSlashRegex = new RegExp('href=["\']' + pathnameNoSlash.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '["\']', 'g');
        html = html.replace(relativeNoSlashRegex, `href="${p.filename}"`);
      }
    }
  }

  // 2. Prepend absolute domain to all root-relative resource URLs (like /wp-content/...) BEFORE handling homepage URLs.
  // This avoids converting "/wp-content" to "/initial_index.htmlwp-content".
  // We match any src, href, srcset, data-src, data-srcset that starts with "/wp-" or similar assets.
  html = html.replace(/(src|href|srcset|data-src|data-srcset)=["']\/([^"']+)["']/g, (match, attr, pathVal) => {
    // If the path value is one of our scraped html files, do not change it
    const isScrapedHtml = pages.some(p => pathVal.startsWith(p.filename));
    if (isScrapedHtml) {
      return match;
    }
    // Also check if pathVal corresponds to one of the raw subpage paths (e.g. "about-us/")
    const isSubpagePath = specificPages.some(p => {
      const parsedPath = new URL(p.url).pathname.replace(/^\/|\/$/g, '');
      return pathVal === parsedPath || pathVal === parsedPath + '/';
    });
    if (isSubpagePath) {
      return match;
    }

    return `${attr}="https://awakeniq.com/${pathVal}"`;
  });

  // 3. Replace the homepage URL ('https://awakeniq.com/' and 'https://awakeniq.com') only if followed by quote or space.
  // This prevents it from matching the prefix of 'https://awakeniq.com/wp-content/...'
  html = html.replace(/https:\/\/awakeniq\.com\/?(?=["'\s])/g, 'initial_index.html');

  // Handle home page root relative URLs specifically (href="/")
  html = html.replace(/href=["\']\/["\']/g, 'href="initial_index.html"');

  // 4. Inject Portal Login link in the navigation menu
  html = html.replace(
    /(<a[^>]*href="initial_contact-us\.html"[^>]*>Contact Us<\/a><\/li>)/g,
    '$1<li class="menu-item nav-item elementskit-mobile-builder-content"><a href="login.html" class="ekit-menu-nav-link" style="color: #386754; font-weight: bold;">Portal Login</a></li>'
  );

  // Handle CSS backgrounds and fonts in stylesheets/styles
  html = html.replace(/url\(["']?\/wp-(content|includes)/g, 'url("https://awakeniq.com/wp-$1');
  html = html.replace(/url\(\/wp-(content|includes)/g, 'url(https://awakeniq.com/wp-$1');

  return html;
}

async function scrapeAll() {
  console.log('Starting scrape to:', outputDir);
  for (const page of pages) {
    console.log(`Fetching ${page.url}...`);
    try {
      const response = await fetch(page.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      let html = await response.text();
      html = rewriteAssetsAndLinks(html);

      const filePath = path.join(outputDir, page.filename);
      fs.writeFileSync(filePath, html, 'utf8');
      console.log(`Saved ${page.filename}`);
    } catch (error) {
      console.error(`Error scraping ${page.url}:`, error);
    }
  }
  console.log('Scrape complete!');
}

scrapeAll();
