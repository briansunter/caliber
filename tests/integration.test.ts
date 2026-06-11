import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const TEST_TIMEOUT = 30_000;
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const TEXT_ONLY_RAR = Buffer.from(
  "UmFyIRoHAM+QcwAADQAAAAAAAAAUoHQggD0AnhQAAPQBEAACbhqo9vJjhkodMx0AIAAAAEZvbGRlcjFcRm9sZGVyIFNwYWNlXGxvbmcudHh0FZUREQ0Q/I2VNSnN/65PPqa7PqScUtAIUhMz0czBYAqZiHdkO6cf8J5UpKEIOgyH6fp/r/j/3/v/f///7fr9/2/z9/9/j8P5fj/P8v6fn/X9P7fr/f9v8fv/n+H2P4/Z/l9r+f2/6fc/r93+33v7/f+D8Hw/h+L8Xx/j+T8ny/l+b83z/n8D2Hg+x8L2Xh+z8T2ni+18b23j+38j3Hk+58r3Xl+78z3nm+98733n+/9D4Ho/B9L4Xp/D9T4nq/F9b43r/H9j5Hs/J9r5Xt/L9z5nu/N9753v/P4DuHA9x4LuXB9z4TunC914bu3D934jvHE954rvXF974zvnG9947v3H9/5DwHI+B5LwXJ+D5TwnK+F5bw3L+H5jxHM+J5rxXN+L5zxnO+N57x3P+P6DyHQ+R6LyXR+T6TynS+V6by3T+X6jzHU+Z6rzXV+b6zznW+d67z3X+f7D0HY+h7L0XZ+j7T0na+l7b03b+n7j1Hc+p7r1Xd+r7z1ne+t7713f+vwDgGA8BwLgWB8DwTgmC8Fwbg2D8HwjhGE8JwrhWF8LwzhmG8Nw7h2H8PxDiGI8RxLiWJ8TxTimK8Vxbi2L8XxjjGM8ZxrjWN8bxzjmO8dx7j2P8fyDkGQ8hyLkWR8jyTkmS8lybk2T8nyjlGU8pyrlWV8ryzlmW8ty7l2X8vzDmGY8xzLmWZ8zzTmma81zbm2b83zjnGc85zrnWd87zznme89z7n2f8/0DoGg9B0LoWh9D0Tomi9F0bo2j9H0jpGk9J0rpWl9L0zpmm9N07p2n9P1DqGo9R1LqWp9T1Tqmq9V1bq2r9X1jrGs9Z1rrWt9b1zrmu9d17r2v9f2CBsMHYoWxw9kibLF2aNs8faJG0ydqlbXL2yZts3bp23z9wobjR3KludPdKm61d2rbvX3ixvNnerW9298ub7d369v95ALyA3kC/X6vIHeQT6e7yC7xeQbebyD71eQje7yE74vIVvm8he+ryGb7vIbvy8h2/byH7+vIhv+8iO4LyJbhvInuK8im47yK7kvItuW8i+5ryMbnvIzui8jW6byN7qvI5uu8ju7LyPbtvI/u68kG77yQ7AvJFsG8kewrySbDvJLsS8k2xbyT7GvJRse8lOyLyVbJvJXsq8lmy7yW7MvJds28l+zryYbPvJjtC8mW0byZ7SvJptO8mu1LybbVvJvta8nG17yc7YvJ1tm8ne2ryebbvJ7ty8n23byf7evKBt+8oOgLyhaBvKHoK8omg7yi6EvKNoW8o+hrykaHvKToi8pWibyl6KvKZou8pujLynaNvKfo68qGj7yo6QvKlpG8qekryqaTvKrpS8q2lbyr6WvKxpe8rOmLytaZvK3pq8rmm7yu6cvK9p28r+nrywafvLDqC8sWobyx6ivLJqO8supLyzalvLPqa8tGp7y06ovLVqm8teqry2arvLbqy8t2rby36uvLhq+8uOsLy5axvLnrK8ums7y660vLtrW8u+try8a3vLzri8vWuby966vL5ru8vuvLy/a9vL/r68wGv7zA4AvMFgG8weArzCYDvMLgS8w2BbzD4GvMRge8xOCLzFYJvMXgq8xmC7zG4MvMdg28x+DrzIYPvMjhC8yWEbzJ4SvMphO8yuFLzLYVvMvha8zGF7zM4YvM1hm8zeGrzOYbvM7hy8z2HbzP4evNBh+80OILzRYhvNHiK80mI7zS4kvNNiW80+JrzUYnvNTii81WKbzV4qvNZiu81uLLzXYtvNfi682GL7zY4wvNljG82eMrzaYzvNrjS822Nbzb42vNxje83OOLzdY5vN3jq83mO7ze48vN9j283+PrzgY/vODkC84WQbzh5CvOJkO84uRLzjZFvOPka85GR7zk5IvOVkm85eSrzmZLvObky852Tbzn5OvOhk+86OULzpZRvOnlK86mU7zq5UvOtlW86+VrzsZXvOzli87WWbzt5avO5lu87uXLzvZdvO/l688GX7zw5gvPFmG88eYrzyZjvPLmS882Zbzz5mvPRme89OaLz1ZpvPXmq89ma7z25svPdm289+brz4ZvvPjnC8+Wcbz55yvPpnO8+udLz7Z1vPvna8/Gd7z854vP1nm8/eerz+Z7vP7ny6/137Xn/z9egBn+9AFegEvQDfXxegIvQFfT3egM3i9AdvN6BDer0CW93oFN8XoFt83oGN9XoGt93oHN+XoHt+3oIN/XoIt/3oJNwXoJtw3oKNxXoKtx3oLNyXoLty3oMNzXoMtz3oNN0XoNt03oON1XoOt13oPN2XoPt23oQN3XoQt33oRNgXoRtg3oSNhXoSth3oTNiXoTti3oUNjXoUtj3oVNkXoVtk3oWNlXoWtl3oXNmXoXtm3oYNnXoYtn3oZNoXoZto3oaNpXoatp3obNqXobtq3ocNrXoctr3odNsXodts3oeNtXoett3ofNuXoftu3ogNvXogtv3ohNAXohtA3oiNBXoitB3ojNCXojtC3okNDXoktD3olNEXoltE3omNFXomtF3onNGXontG3ooNHXootH3opNIXoptI3oqNJXoqtJ3orNKXortK3osNLXostL3otNMXottM3ouNNXoutN3ovNOXovtO3owNPXowtP3oxNQXoxtQ3oyNRXoytR3ozNSXoztS3o0NTXo0tT3o1NUXo1tU3o2NVXo2tV3o3NWXo3tW3o4NXXo4tX3o5NYXo5tY3o6NZXo6tZ3o7NaXo7ta3o8NbXo8tb3o9NcXo9tc3o+NdXo+td3o/NeXo/te3pANfXpAtf3pBMAXpBsA3pCMBXpCsB3pDMCXpDsC3pEMDXpEsD3pFMEXpFsE3pGMFXpGsF3pHMGXpHsG3pIMHXpIsH3pJMIXpJsI3pKMJXpKsJ3pLMKXpLsK3pMMLXpMsL3pNMMXpNsM3pOMNXpOsN3pPMOXpPsO3pQMPXpQsP3pRMQXpRsQ3pSMRXpSsR3pTMSXpTsS3pUMTXpUsT3pVMUXpVsU3pWMVXpWsV3pXMWXpXsW3pYMXXpYsX3pZMYXpZsY3paMZXpasZ3pbMaXpbsa3pcMbXpcsb3pdMcXpdsc3peMdXpesd3pfMeXpfse3pgMfXpgsf3phMgXphsg3piMhXpish3pjMiXpjsi3pkMjXpksj3plMkXplsk3pmMlXpmsl3pnMmXpnsm3poMnXposn3ppdh+99u2femmyjemoylemqynemsypemuyremwytemyyvem0yxem2yzem4y1em6y3em8y5em+y7enAy9enCy/enEzBenGzDenIzFenKzHenMzJenOzLenQzNenSzPenUzRenWzTenYzVenazXenczZenezbengzdenizfenkzhenmzjenozlenqznenszpenuzrenwztenyzven0zxen2zzen4z1en6z3en8z5en+z7eoAz9eoCz/eoEXqBl6gh9fF6gpeoMfT3eoObxeoQbzeoSb1eoUb3eoWb4vUMN83qGm+r1Djfd6h5vy9RA37eoib+vUSN/3qJm4L1FDcN6ipuK9RY3HeoubkvUYNy3qMm5r1Gjc96jZui9Rw3Teo6bqvUeN13qPm7L1IDdt6kJu69SI3fepGbAvUkNg3qSmwr1JjYd6k5sS9Sg2LepSbGvUqNj3qVmyL1LDZN6lpsq9S42XepebMvUwNm3qYmzr1MjZ96mZtC9TQ2jepqbSvU2Np3qbm1L1ODat6nJta9To2vep2bYvU8Ns3qem2r1Pjbd6n5ty9UA27eqCbevVCNv3qhmgL1RDQN6opoK9UY0HeqOaEvVINC3qkmhr1SjQ96pZoi9Uw0TeqaaKvVONF3qnmjL1UDRt6qJo69VI0feqmaQvVUNI3qqmkr1VjSd6q5pS9Vg0reqyaWvVaNL3qtmmL1XDTN6rppq9V403eq+acvVgNO3qwmnr1YjT96sZqC9WQ1DerKaivVmNR3qzmpL1aDUt6tJqa9Wo1PerWaovVsNU3q2mqr1bjVd6t5qy9XA1beriauvVyNX3q5msL1dDWN6uvbgvfTtQXq7Gs71dzWl6vBrW9Xk1ter0a3vV7NcXq+Gub1fTXV6vxru9X815esAa9vWBNfXrBGv71gzAF6whgG9YUwFesMYDvWHMCXrEGBb1iTA16xRge9YswResYYJvWNMFXrHGC71jzBl6yBg29ZEwdeskYPvWTMIXrKGEb1lTCV6yxhO9ZcwpeswYVvWZMLXrNGF71mzDF6zhhm9Z0w1es8YbvWfMOXrQGHb1oTD160Rh+9aMxBetIYhvWlMRXrTGI71pzEl61BiW9akxNetUYnvWrMUXrWGKb1rTFV61xiu9a8xZetgYtvWxMXXrZGL71szGF62hjG9bUxletsYzvW3MaXrcGNb1uTG163Rje9bsxxet4Y5vW9MdXrfGO71vzHl64Bj29cEx9euEY/vXDMgXriGQb1xTIV64xkO9ccyJeuQZFvXJMjXrlGR71yzJF65hkm9c0yVeucZLvXPMmXroGTb10TJ166Rk+9dMyheuoZRvXVMpXrrGU711zKl67BlW9dkyteu0ZXvXbMsXruGWb13TLV67xlu9d8y5evAZdvXhMvXrxGX714zMF68hmG9eUzFevMZjvXnMyXr0GZb16TM169Rme9eszRevYZpvXtM1Xr3Ga717zNl6+Bm29fEzdevkZvvXzM4Xr6Gcb19TOV6+xnO9fczpevwZ1vX5M7Xr9Gd71+zPF6/hnm9f0z1ev92fb312fb1/zPl4ABn28AEz9eAEZ/vADF4AgvAFH18XgDC8AcfT3eAQN4vAJG83gFDerwCxvd4Bg3xeAaN83gHDfV4B433eAgN+XgIjft4CQ39eAmN/3gKDcF4Co3DeAsNxXgLjcd4DA3JeAyNy3gNDc14DY3PeA4N0XgOjdN4Dw3VeA+N13gQDdl4EI3beBEN3XgRjd94Eg2BeBKNg3gTDYV4E42HeBQNiXgUjYt4FQ2NeBWNj3gWDZF4Fo2TeBcNlXgXjZd4GA2ZeBiNm3gZDZ14GY2feBoNoXgajaN4Gw2leBuNp3gcDal4HI2reB0NrXgdja94Hg2xeB6Ns3gfDbV4H423eCANuXggjbt4IQ29eCGNv3giDQF4Io0DeCMNBXgjjQd4JA0JeCSNC3glDQ14JY0PeCYNEXgmjRN4Jw0VeCeNF3goDRl4KI0beCkNHXgpjR94Kg0heCqNI3grDSV4K40neCwNKXgsjSt4LQ0teC2NL3guDTF4Lo0zeC8NNXgvjTd4MA05eDCNO3gxDT14MY0/eDINQXgyjUN4Mw1FeDONR3g0DUl4NI1LeDUNTXg1jU94Ng1ReDaNU3g3DVV4N41XeDgNWXg4jVt4OQ1deDmNX3g6DWF4Oo1jeDsNZXg79iG99OyjeDwNaXg8jWt4PQ1teD2Nb3g+DXF4Po1zeD8NdXg/jXd4QA15eECNe3hBDX14QY1/eEIMAXhCjAN4QwwFeEOMB3hEDAl4RIwLeEUMDXhFjA94RgwReEaME3hHDBV4R4wXeEgMGXhIjBt4SQwdeEmMH3hKDCF4SowjeEsMJXhLjCd4TAwpeEyMK3hNDC14TYwveE4MMXhOjDN4Tww1eE+MN3hQDDl4UIw7eFEMPXhRjD94UgxBeFKMQ3hTDEV4U4xHeFQMSXhUjEt4VQxNeFWMT3hWDFF4VoxTeFcMVXhXjFd4WAxZeFiMW3hZDF14WYxfeFoMYXhajGN4WwxleFuMZ3hcDGl4XIxreF0MbXhdjG94XgxxeF6Mc3hfDHV4X4x3eGAMeXhgjHt4YQx9eGGMf3hiDIF4YoyDeGMMhXhjjId4ZAyJeGSMi3hlDI14ZYyPeGYMkXhmjJN4ZwyVeGeMl3hoDJl4aIybeGkMnXhpjJ94agyheGqMo3hrDKV4a4yneGwMqXhsjKt4bQyteG2Mr3huDLF4boyzeG8MtXhvjLd4cAy5eHCMu3hxDL14cYy/eHIduy99dkK8OUZhvDmGYrw5xmO8OgZkvDpGZbw6hma8OsZnvDsGaLw7Rmm8O4ZqvDvGa7w8Bmy8PEZtvDyGbrw8xm+8PQZwvD1Gcbw9hnK8PcZzvD4GdLw+RnW8PoZ2vD7Gd7w/Bni8P0Z5vD+Gerw/xnu8QAZ8vEBGfbxAhn68QMZ/vEEC8QULxBg+vi8QcLxCA+nu8QkN4vEKDebxCw3q8QwN7vENDfF4hwb5vEPDfV4iAb7vERDfl4iQb9vETDf14igb/vEVDcF4iwbhvEXDcV4jAbjvEZDcl4jQblvEbDc14jgbnvEdDdF4jwbpvEfDdV4kAbrvEhDdl4kQbtvEjDd14kgbvvElDYF4kwbBvEnDYV4lAbDvEpDYl4lQbFvErDY14lgbHvEtDZF4lwbJvEvDZV4mAbLvExDZl4mQbNvEzDZ14mgbPvE1DaF4mwbRvE3DaV4nAbTvE5Dal4nQbVvE7Da14ngbXvE9DbF4nwbZvE/DbV4oAbbvFBDbl4oQbdvFDDb14ogbfvFFDQF4owaBvFHDQV4pAaD5MUm99DsOXilBoW8UsNDXimBoe8U0NEXinBom8U8NFXioBou8VENGXipBo28VMNHXiqBo+8VUNIXirBpG8VcNJXisBpO8VkNKXitBpW8VsNLXiuBpe8V0NMXivBpm8V8NNXiwBpu8WENOXixBp28WMNPXiyBp+8WUNQXizBqG8WcNRXi0BqO8WkNSXi1BqW8WsNTXi2Bqe8W0NUXi3Bqm8W8NVXi4Bqu8XENWXi5Bq28XMNXXi6Bq+8XUNYXi7BrG8XcNZXi8BrO8XkNaXi9BrW8XsNbXi+Bre8X0NcXi/Brm8X8NdXjABru8YENeXjBBr28YMNfXjCBr+8YUMAXjDBgG8YcMBXjEBgO8YkMCXjFBgW8YsMDXjGBge8Y0MEXjHBgm8Y8MFXjIBgu8ZEMGXjJBg28ZMMHXjKBg+8ZUMIXjLBhG8ZcMJXjMBhO8ZkMKXjNBhW8ZsMLXjOBhe8Z0MMXjPBhm8Z8MNXjQBhu8aEMOXjRBh28aMMPXjSBh+8aUMQXjTHYvvfXZx/2gC+OdCCSSwAPAAAADwAAAAJbA9icKaGDSh0wJgAgAAAARm9sZGVyMVxGb2xkZXIgPz9cMj8/LnR4dABO2w0th2UAbC2HZQIA8CYSGO+7v+S4reaWh+S4reaWh5QGdOCQOQAAAAAAAAAAAAIAAAAARWSGShQwFAAQAAAARm9sZGVyMVxGb2xkZXIgU3BhY2UAsFjVbU9BdOCSPQAAAAAAAAAAAAIAAAAAR2SGShQwGAAQAAAARm9sZGVyMVxGb2xkZXIgPz8ATtgNLYdlAPCsNUv20XTgkCwAAAAAAAAAAAACAAAAADBkhkoUMAcAEAAAAEZvbGRlcjEAsKoVaMQ9ewBABwA=",
  "base64",
);
const CBR_FIXTURE = Buffer.from(
  "UmFyIRoHAM+QcwAADQAAAAAAAAAMJXQggCwAtgAAANwAAAAAbLFw2gAAISodNQwAIAAAAHRlc3RmaWxlLmpwZ+cYFf7V/ydkeNQh1MKmm6OAexVPlvVHrzqPE5mVHC08ghs85LfafCcldrlGYJPnjkgNzK9t4fZEpePKwmfeq9nqNRVssG8auWw3ppmChio3P4QobbIIu+aDvAnlNhtw7eU/yPyMBuPEssZjwTehsh4DZgC5HXWGFUVxgDrn+6KnVDXP/2B26ds102b/eZa5elob/BycnuXvN92AXobBxHJ4Ebq+7rCITbK7Lz6UAAC/iGf2qf/UUW50IIAsAFQAAABXAAAAAGKssK8AACEqHTUMACAAAAB0ZXN0ZmlsZS5wbmenGIjF+7VC0fPe1feyyXAlT4G/SVtSdAyd7pMHsE3FAkIqbrYBRgyQp7m1pxzv+HOHpfwCaeA8jA41QCxmUCvsyGsqR5gONgQCwAAAAL+IZ/ap/9TEPXsAQAcA",
  "base64",
);

let tempDir = "";
let libraryPath = "";
let homePath = "";
let baseUrl = "";
let serverProcess: ReturnType<typeof Bun.spawn> | null = null;

function drainPipe(pipe: unknown) {
  if (pipe instanceof ReadableStream) {
    void new Response(pipe).text();
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate a port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }

  throw lastError instanceof Error ? lastError : new Error("Server did not start");
}

function createPdf(): Uint8Array {
  const text = "BT /F1 18 Tf 72 720 Td (Caliber PDF fixture) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}

async function createEpub(path: string, title: string) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:identifier id="bookid">urn:uuid:fixture-${title.replace(/\W+/g, "-")}</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="styles.css" media-type="text/css"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter1"/>
  </spine>
</package>`,
  );
  zip.file(
    "OEBPS/toc.ncx",
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="fixture"/></head>
  <docTitle><text>${title}</text></docTitle>
  <navMap>
    <navPoint id="chapter1" playOrder="1">
      <navLabel><text>Start</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`,
  );
  zip.file(
    "OEBPS/chapter1.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${title}</title><link rel="stylesheet" href="styles.css"/></head>
  <body><h1>${title}</h1><p>Fixture chapter.</p></body>
</html>`,
  );
  zip.file("OEBPS/styles.css", "body { font-family: serif; }");
  await Bun.write(path, await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

async function createCbz(path: string) {
  const zip = new JSZip();
  zip.file("001.png", ONE_BY_ONE_PNG);
  zip.file("002.png", ONE_BY_ONE_PNG);
  await Bun.write(path, await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

async function createCbr(path: string) {
  await Bun.write(path, CBR_FIXTURE);
}

async function createFixtureLibrary() {
  mkdirSync(libraryPath, { recursive: true });
  const db = new Database(join(libraryPath, "metadata.db"));

  db.exec(`
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort TEXT, link TEXT NOT NULL DEFAULT '');
    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      sort TEXT,
      timestamp TEXT,
      pubdate TEXT,
      series_index REAL NOT NULL DEFAULT 1.0,
      author_sort TEXT,
      path TEXT NOT NULL,
      flags INTEGER NOT NULL DEFAULT 1,
      uuid TEXT NOT NULL,
      has_cover INTEGER DEFAULT 0,
      last_modified TEXT
    );
    CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, author INTEGER NOT NULL, UNIQUE(book, author));
    CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, publisher INTEGER NOT NULL, UNIQUE(book, publisher));
    CREATE TABLE books_ratings_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, rating INTEGER NOT NULL, UNIQUE(book, rating));
    CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, series INTEGER NOT NULL, UNIQUE(book));
    CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, tag INTEGER NOT NULL, UNIQUE(book, tag));
    CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, text TEXT NOT NULL);
    CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, format TEXT NOT NULL COLLATE NOCASE, uncompressed_size INTEGER NOT NULL, name TEXT);
    CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'isbn' COLLATE NOCASE, val TEXT NOT NULL COLLATE NOCASE, UNIQUE(book, type));
    CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, sort TEXT COLLATE NOCASE);
    CREATE TABLE ratings (id INTEGER PRIMARY KEY, rating INTEGER NOT NULL UNIQUE);
    CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, sort TEXT COLLATE NOCASE);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
    CREATE INDEX authors_idx ON authors(sort);
    CREATE INDEX books_idx ON books(sort);
    CREATE INDEX books_authors_link_aidx ON books_authors_link(author);
    CREATE INDEX books_authors_link_bidx ON books_authors_link(book);
    CREATE INDEX data_book_index ON data(book);
    CREATE INDEX data_format_index ON data(format);
  `);

  db.run("INSERT INTO authors (id, name, sort) VALUES (1, 'Alice Author', 'Author, Alice')");
  db.run("INSERT INTO authors (id, name, sort) VALUES (2, 'Bob Writer', 'Writer, Bob')");
  db.run("INSERT INTO authors (id, name, sort) VALUES (3, 'Invalid Author', 'Author, Invalid')");
  db.run("INSERT INTO series (id, name, sort) VALUES (1, 'Fixture Series', 'Fixture Series')");
  db.run("INSERT INTO tags (id, name) VALUES (1, 'Comics')");
  db.run("INSERT INTO tags (id, name) VALUES (2, 'Fiction')");
  db.run("INSERT INTO publishers (id, name, sort) VALUES (1, 'Fixture Press', 'Fixture Press')");
  db.run("INSERT INTO ratings (id, rating) VALUES (1, 8)");
  db.run(`
    INSERT INTO books
      (id, title, sort, timestamp, pubdate, series_index, author_sort, path, flags, uuid, has_cover, last_modified)
    VALUES
      (1, 'Alpha & Beta', 'Alpha & Beta', '2024-01-02 00:00:00+00:00', '2023-01-01 00:00:00+00:00', 1.0, 'Author, Alice', 'Alpha Book', 1, '11111111-1111-1111-1111-111111111111', 0, '2024-01-02 00:00:00+00:00'),
      (2, 'Gamma Search', 'Gamma Search', '2024-01-03 00:00:00+00:00', '2023-01-02 00:00:00+00:00', 1.0, 'Writer, Bob', 'Gamma Book', 1, '22222222-2222-2222-2222-222222222222', 0, '2024-01-03 00:00:00+00:00'),
      (3, 'Invalid EPUB', 'Invalid EPUB', '2024-01-04 00:00:00+00:00', '2023-01-03 00:00:00+00:00', 1.0, 'Author, Invalid', 'Invalid Book', 1, '33333333-3333-3333-3333-333333333333', 0, '2024-01-04 00:00:00+00:00')
  `);
  db.run(`
    INSERT INTO identifiers (book, type, val) VALUES
      (1, 'isbn', '9780000000001'),
      (2, 'isbn', '9780000000002')
  `);
  db.run("INSERT INTO books_authors_link (book, author) VALUES (1, 1), (2, 2), (3, 3)");
  db.run("INSERT INTO books_series_link (book, series) VALUES (1, 1)");
  db.run("INSERT INTO books_tags_link (book, tag) VALUES (1, 1), (1, 2), (2, 2)");
  db.run("INSERT INTO books_publishers_link (book, publisher) VALUES (1, 1)");
  db.run("INSERT INTO books_ratings_link (book, rating) VALUES (1, 1)");
  db.run("INSERT INTO comments (book, text) VALUES (1, '<p>Alpha description</p>')");
  db.run(`
    INSERT INTO data (book, format, uncompressed_size, name) VALUES
      (1, 'EPUB', 0, 'Alpha Book'),
      (1, 'PDF', 0, 'Alpha Book'),
      (1, 'CBZ', 0, 'Alpha Book'),
      (1, 'CBR', 0, 'Alpha Book'),
      (2, 'EPUB', 0, 'Gamma Book'),
      (3, 'EPUB', 0, 'Invalid Book')
  `);
  db.close();

  const alphaDir = join(libraryPath, "Alpha Book");
  const gammaDir = join(libraryPath, "Gamma Book");
  const invalidDir = join(libraryPath, "Invalid Book");
  mkdirSync(alphaDir, { recursive: true });
  mkdirSync(gammaDir, { recursive: true });
  mkdirSync(invalidDir, { recursive: true });
  await createEpub(join(alphaDir, "Alpha Book.epub"), "Alpha & Beta");
  await Bun.write(join(alphaDir, "Alpha Book.pdf"), createPdf());
  await createCbz(join(alphaDir, "Alpha Book.cbz"));
  await createCbr(join(alphaDir, "Alpha Book.cbr"));
  await createEpub(join(gammaDir, "Gamma Book.epub"), "Gamma Search");
  await Bun.write(
    join(invalidDir, "Invalid Book.epub"),
    "<!doctype html><html><head><title>Not an EPUB</title></head><body>wrong file</body></html>",
  );
}

function parseXml(xml: string) {
  const errors: string[] = [];
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (message) => errors.push(String(message)),
      fatalError: (message) => errors.push(String(message)),
    },
  }).parseFromString(xml, "application/xml");

  expect(errors).toEqual([]);
  expect(doc.documentElement).toBeTruthy();
  return doc;
}

async function fetchText(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  expect(response.status).toBe(200);
  parseXml(text);
  return text;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "caliber-integration-"));
  libraryPath = join(tempDir, "library");
  homePath = join(tempDir, "home");
  mkdirSync(homePath, { recursive: true });
  await createFixtureLibrary();

  const port = await freePort();
  baseUrl = `http://localhost:${port}`;
  serverProcess = Bun.spawn(["bun", "src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homePath,
      CALIBRE_LIBRARY_PATH: libraryPath,
      PORT: String(port),
      NODE_ENV: "test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  drainPipe(serverProcess.stdout);
  drainPipe(serverProcess.stderr);
  await waitForServer(baseUrl);
}, TEST_TIMEOUT);

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill();
    await serverProcess.exited.catch(() => {});
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("OPDS catalog", () => {
  test("renders valid navigation and acquisition feeds", async () => {
    const root = await fetchText("/opds");
    expect(root).toContain("Authors");
    expect(root).toContain("Series");
    expect(root).toContain("Tags");
    expect(root).toContain("Formats");

    const feeds = [
      "/opds/books?limit=1",
      "/opds/recent?limit=1",
      "/opds/search?q=Alpha",
      "/opds/book/1",
      "/opds/authors",
      "/opds/authors/1/books",
      "/opds/series",
      "/opds/series/1/books",
      "/opds/tags",
      "/opds/tags/1/books",
      "/opds/formats",
      "/opds/formats/EPUB/books",
    ];

    for (const path of feeds) {
      const xml = await fetchText(path);
      expect(xml).toContain("<feed");
    }

    const paged = await fetchText("/opds/books?limit=1");
    expect(paged).toContain('rel="next"');
  });

  test("renders a valid OpenSearch description", async () => {
    const xml = await fetchText("/opds/search.xml");
    expect(xml).toContain("OpenSearchDescription");
    expect(xml).toContain("searchTerms");
  });
});

describe("file and reader endpoints", () => {
  test("supports HEAD, ETags, byte ranges, If-Range, and no-cache revalidation", async () => {
    const head = await fetch(`${baseUrl}/api/books/1/file/PDF`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(head.headers.get("cache-control")).toBe("no-cache");
    const etag = head.headers.get("etag");
    expect(etag).toBeTruthy();

    const notModified = await fetch(`${baseUrl}/api/books/1/file/PDF`, {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(notModified.status).toBe(304);

    const range = await fetch(`${baseUrl}/api/books/1/file/PDF`, {
      headers: { Range: "bytes=0-99" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toMatch(/^bytes 0-99\//);
    expect(await range.arrayBuffer()).toHaveProperty("byteLength", 100);

    const matchingIfRange = await fetch(`${baseUrl}/api/books/1/file/PDF`, {
      headers: { Range: "bytes=0-99", "If-Range": etag ?? "" },
    });
    expect(matchingIfRange.status).toBe(206);

    const staleIfRange = await fetch(`${baseUrl}/api/books/1/file/PDF`, {
      headers: { Range: "bytes=0-99", "If-Range": '"stale"' },
    });
    expect(staleIfRange.status).toBe(200);
    expect(staleIfRange.headers.get("content-range")).toBeNull();

    const invalidRange = await fetch(`${baseUrl}/api/books/1/file/PDF`, {
      headers: { Range: "bytes=999999-1000000" },
    });
    expect(invalidRange.status).toBe(416);
  });

  test("serves unpacked EPUB entries without downloading the archive", async () => {
    const container = await fetch(`${baseUrl}/api/books/1/epub/META-INF/container.xml`);
    expect(container.status).toBe(200);
    expect(container.headers.get("content-type")).toContain("application/xml");
    expect(await container.text()).toContain("OEBPS/content.opf");

    const displayOptions = await fetch(
      `${baseUrl}/api/books/1/epub/META-INF/com.apple.ibooks.display-options.xml`,
    );
    expect(displayOptions.status).toBe(200);
    expect(displayOptions.headers.get("content-type")).toContain("application/xml");
    expect(await displayOptions.text()).toContain("<display_options");

    const chapterRange = await fetch(`${baseUrl}/api/books/1/epub/OEBPS/chapter1.xhtml`, {
      headers: { Range: "bytes=0-40" },
    });
    expect(chapterRange.status).toBe(206);
    expect(chapterRange.headers.get("content-range")).toMatch(/^bytes 0-40\//);
  });

  test("returns a non-500 response for malformed EPUB archives", async () => {
    const streamed = await fetch(`${baseUrl}/api/books/3/epub/META-INF/container.xml`);
    expect(streamed.status).toBe(422);
    expect(await streamed.json()).toMatchObject({
      code: "invalid_epub",
      error: "Invalid EPUB archive",
    });

    const fileHead = await fetch(`${baseUrl}/api/books/3/file/EPUB`, { method: "HEAD" });
    expect(fileHead.status).toBe(200);
  });

  test("serves CBZ, CBR, and PDF page manifests and page images", async () => {
    const cbzManifest = await fetch(`${baseUrl}/api/books/1/pages/CBZ/manifest`);
    expect(cbzManifest.status).toBe(200);
    const cbz = (await cbzManifest.json()) as { pageCount: number; pages: { href: string }[] };
    expect(cbz.pageCount).toBe(2);
    expect(cbz.pages[0]?.href).toBe("/api/books/1/pages/CBZ/1");

    const cbzPage = await fetch(`${baseUrl}${cbz.pages[0]?.href}`);
    expect(cbzPage.status).toBe(200);
    expect(cbzPage.headers.get("content-type")).toContain("image/png");

    const cbrManifest = await fetch(`${baseUrl}/api/books/1/pages/CBR/manifest`);
    expect(cbrManifest.status).toBe(200);
    const cbr = (await cbrManifest.json()) as { pageCount: number; pages: { href: string }[] };
    expect(cbr.pageCount).toBe(2);
    expect(cbr.pages[0]?.href).toBe("/api/books/1/pages/CBR/1");

    const cbrPage = await fetch(`${baseUrl}${cbr.pages[0]?.href}`);
    expect(cbrPage.status).toBe(200);
    expect(cbrPage.headers.get("content-type")).toMatch(/^image\//);

    const pdfManifest = await fetch(`${baseUrl}/api/books/1/pages/PDF/manifest`);
    expect(pdfManifest.status).toBe(200);
    const pdf = (await pdfManifest.json()) as { pageCount: number; pages: { href: string }[] };
    expect(pdf.pageCount).toBe(1);

    const pdfPage = await fetch(`${baseUrl}${pdf.pages[0]?.href}`);
    expect(pdfPage.status).toBe(200);
    expect(pdfPage.headers.get("content-type")).toContain("image/png");
  }, TEST_TIMEOUT);
});
