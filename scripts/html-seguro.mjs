/**
 * Sanitização do HTML que circula entre o app e os journals.
 *
 * Duas fontes, dois motivos:
 *   - **anotações dos jogadores**: o conteúdo é escrito por um jogador e lido
 *     por todo mundo, o mestre inclusive. Sem allowlist, um `<script>` (ou um
 *     `onerror=` num atributo) salvo no próprio diário rodaria no navegador de
 *     quem abrisse — e é o navegador do mestre que executa o relay.
 *   - **acervo**: o mestre é confiável, mas o mesmo filtro nos dois caminhos é
 *     mais simples de manter do que dois regimes de confiança, e ainda apara
 *     marcação que o app não sabe exibir.
 *
 * Roda no client do mestre, onde há DOM de verdade — parsear com `DOMParser`
 * é o que torna a limpeza confiável: o navegador resolve por nós as mil
 * formas de escrever a mesma tag, que uma varredura por regex erraria.
 * O documento criado é inerte: `text/html` não executa script nem carrega
 * recurso nenhum.
 */

/** Tags que sobrevivem. É o que `.prosa-foundry` sabe estilizar no front, mais o básico de texto. */
const PERMITIDAS = new Set([
  "p", "br", "hr",
  "strong", "b", "em", "i", "u", "s", "sub", "sup", "code", "pre", "blockquote",
  "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "a", "span", "div"
]);

/**
 * Tags removidas com o conteúdo junto. As outras não permitidas são
 * "desembrulhadas" (o texto fica, a tag some) — aqui não: o conteúdo de um
 * `<script>` é o próprio código, e o de um `<style>` é CSS que não deveria
 * virar texto na tela.
 */
const REMOVIDAS_INTEIRAS = new Set([
  "script", "style", "iframe", "object", "embed", "link", "meta", "form",
  "input", "button", "select", "textarea", "svg", "math", "audio", "video",
  "source", "canvas", "template", "noscript", "base", "img"
]);

/** Atributos que ficam, por tag. Tudo que não estiver aqui cai — `on*`, `style`, `class`, `data-*` incluídos. */
const ATRIBUTOS = {
  a: new Set(["href", "title"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
  ol: new Set(["start"])
};

/** Só link que leva a algum lugar de fora. Corta `javascript:`, `data:` e afins. */
function hrefSeguro(valor) {
  return /^(https?:\/\/|mailto:)/i.test(String(valor ?? "").trim());
}

function limparElemento(elemento) {
  const tag = elemento.tagName.toLowerCase();

  if (REMOVIDAS_INTEIRAS.has(tag)) {
    elemento.remove();
    return;
  }

  // Os filhos primeiro: desembrulhar o pai depois mantém a árvore consistente
  // (e um filho proibido não escapa por ter subido de nível).
  for (const filho of [...elemento.children]) limparElemento(filho);

  if (!PERMITIDAS.has(tag)) {
    elemento.replaceWith(...elemento.childNodes);
    return;
  }

  const permitidos = ATRIBUTOS[tag];
  for (const atributo of [...elemento.attributes]) {
    const nome = atributo.name.toLowerCase();
    if (!permitidos?.has(nome)) {
      elemento.removeAttribute(atributo.name);
    } else if (nome === "href" && !hrefSeguro(atributo.value)) {
      elemento.removeAttribute(atributo.name);
    }
  }
}

/** HTML podado à allowlist acima. Devolve string vazia para entrada vazia. */
export function sanitizarHtml(html) {
  const bruto = String(html ?? "").trim();
  if (!bruto) return "";
  const documento = new DOMParser().parseFromString(bruto, "text/html");
  for (const filho of [...documento.body.children]) limparElemento(filho);
  return documento.body.innerHTML.trim();
}

/** Elementos que separam uma linha da seguinte — sem isto "<li>dois</li><li>três</li>" viraria "doistrês". */
const BLOCOS = "p, div, br, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre";

/** O texto visível do HTML — usado para medir tamanho e montar prévias sem contar marcação. */
export function textoDoHtml(html) {
  const bruto = String(html ?? "");
  if (!bruto) return "";
  const documento = new DOMParser().parseFromString(bruto, "text/html");
  for (const bloco of documento.body.querySelectorAll(BLOCOS)) {
    bloco.after(documento.createTextNode("\n"));
  }
  return (documento.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
