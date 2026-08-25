// Renders an HTML file to PDF with Electron's printToPDF. Electron is already a
// dependency, so this needs no headless browser or print toolchain.
//
//   node src/dev/make-pdf.js docs/report/comparison.html docs/report/comparison.pdf
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [input, output] = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!input || !output) {
  console.error('usage: electron src/dev/make-pdf.js <input.html> <output.pdf>');
  process.exit(1);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 1400 });
  try {
    await win.loadFile(path.resolve(input));
    // Fonts and layout settle before measuring page breaks.
    await new Promise((r) => setTimeout(r, 600));

    const pdf = await win.webContents.printToPDF({
      printBackground: true, // the report uses tinted panels and rules
      preferCSSPageSize: true, // honour the @page rule in the stylesheet
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font-size:7pt;color:#8892a0;' +
        'font-family:Helvetica,Arial,sans-serif;padding:0 16mm;">' +
        '<span style="float:left">Wallwright and the commercial alternatives</span>' +
        '<span style="float:right">' +
        '<span class="pageNumber"></span> of <span class="totalPages"></span>' +
        '</span></div>',
    });

    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(path.resolve(output), pdf);
    const kb = Math.round(fs.statSync(path.resolve(output)).size / 1024);
    console.log(`PDF ${output} (${kb}KB)`);
    app.exit(0);
  } catch (e) {
    console.error('pdf failed:', e.message);
    app.exit(1);
  }
});
