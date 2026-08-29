/**
 * Compendio: o material que o mestre mostra à mesa — o retrato do NPC, a carta
 * achada no corpo, o mapa da cripta, o texto de um pergaminho.
 *
 * Nada aqui escreve: quem monta o material é o mestre, pela interface do
 * Foundry, e quem decide **quando** um jogador pode ver é ele também, pela
 * posse do journal. Um journal novo nasce invisível (o padrão do Foundry é
 * ninguém ver) e aparece na tela do jogador no instante em que o mestre lhe
 * dá Observador — sem passo nenhum de "publicar" inventado por nós.
 *
 * A pasta pode ter subpastas à vontade (por sessão, por capítulo, por NPC), e
 * o journal conta como mais um nível delas: quem abre e vê é a **página**.
 * O app navega essa árvore inteira, do jeito que o mestre a organizou.
 *
 * Só páginas de **texto** e de **imagem**. Vídeo, PDF e as demais que o
 * Foundry aceita ficam de fora — o app não tem como exibi-las bem no celular,
 * e mostrar um material pela metade é pior do que não listá-lo.
 */

import { sanitizarHtml, textoDoHtml } from "./html-seguro.mjs";

/** Nome da pasta raiz no Foundry. O mestre organiza dentro dela como quiser. */
export const NOME_PASTA = "Conteúdos Para Jogadores";

/** Compara nomes de pasta ignorando acento e caixa — ver `pastaRaiz`. */
function mesmoNome(a, b) {
  const simplificar = (texto) =>
    String(texto ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  return simplificar(a) === simplificar(b);
}

/** Quantos caracteres de texto entram na prévia da lista. */
const RESUMO_MAX = 160;

/**
 * A pasta, achada por nome sem exigir os acentos: uma versão anterior do
 * módulo criou "Conteudos Para Jogadores", e um mestre que digite o nome à
 * mão dificilmente acerta a acentuação de primeira. Achar as duas é o que
 * evita o mundo terminar com duas pastas quase iguais.
 */
export function pastaRaiz() {
  return game.folders.find((pasta) => pasta.type === "JournalEntry" && mesmoNome(pasta.name, NOME_PASTA)) ?? null;
}

export async function garantirPasta() {
  const existente = pastaRaiz();
  if (!existente) return Folder.create({ name: NOME_PASTA, type: "JournalEntry", sorting: "a" });
  // Achada pela grafia antiga: corrige o nome no mundo, em vez de deixar o
  // mestre com uma pasta escrita errado para sempre.
  if (existente.name !== NOME_PASTA) await existente.update({ name: NOME_PASTA });
  return existente;
}

function paginasVisiveis(journal, user) {
  return [...journal.pages]
    .filter((pagina) => pagina.testUserPermission(user, "OBSERVER"))
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .flatMap((pagina) => {
      if (pagina.type === "text") {
        const conteudo = sanitizarHtml(pagina.text?.content);
        const texto = textoDoHtml(conteudo).replace(/\s+/g, " ");
        return [
          {
            id: pagina.id,
            titulo: pagina.name,
            tipo: "texto",
            conteudo,
            src: "",
            legenda: "",
            resumo: texto.length > RESUMO_MAX ? `${texto.slice(0, RESUMO_MAX)}…` : texto
          }
        ];
      }
      if (pagina.type === "image" && pagina.src) {
        return [
          {
            id: pagina.id,
            titulo: pagina.name,
            tipo: "imagem",
            conteudo: "",
            // Caminho como o Foundry o guarda; quem o transforma em URL
            // servível pelo front é o servidor Node (ver absolutizarImagem).
            src: pagina.src,
            legenda: pagina.image?.caption ?? "",
            resumo: pagina.image?.caption ?? ""
          }
        ];
      }
      return [];
    });
}

const porNome = (a, b) => a.nome.localeCompare(b.nome, "pt-BR");

/**
 * O conteúdo de uma pasta, descendo até as páginas.
 *
 * O journal entra na árvore como mais um nível de pasta: ele agrupa páginas,
 * e é a **página** que o jogador abre para ver — a carta, o retrato, o trecho
 * de texto. Um journal de uma página só continua sendo um nível, mas a tela
 * atalha direto para ela.
 *
 * Pasta ou journal que não sobrou nada visível não entra: para o jogador
 * seria uma porta que abre no vazio. `visitadas` guarda contra uma pasta que
 * aponte para um ancestral (configuração quebrada, laço infinito).
 */
function conteudoDaPasta(pasta, user, visitadas) {
  if (visitadas.has(pasta.id)) return { pastas: [], journals: [] };
  visitadas.add(pasta.id);

  const pastas = game.folders
    .filter((filha) => filha.type === "JournalEntry" && filha.folder?.id === pasta.id)
    .map((filha) => ({ id: filha.id, nome: filha.name, ...conteudoDaPasta(filha, user, visitadas) }))
    .filter((filha) => filha.pastas.length || filha.journals.length)
    .sort(porNome);

  const journals = game.journal
    .filter((journal) => journal.folder?.id === pasta.id && journal.testUserPermission(user, "OBSERVER"))
    .map((journal) => ({ id: journal.id, nome: journal.name, paginas: paginasVisiveis(journal, user) }))
    .filter((journal) => journal.paginas.length)
    .sort(porNome);

  return { pastas, journals };
}

/** O compêndio que este jogador pode ver agora, da raiz até as páginas. */
export function listarCompendio(user) {
  const raiz = pastaRaiz();
  if (!raiz) return { pastas: [], journals: [] };
  return conteudoDaPasta(raiz, user, new Set());
}

/**
 * Esta mudança mexe em algo do compêndio? Sobe a cadeia de pastas até a raiz —
 * o journal pode estar a qualquer profundidade. Filtra o ruído das outras
 * pastas do mundo.
 */
export function ehDaPasta(journal) {
  const raiz = pastaRaiz();
  if (!raiz || !journal?.folder) return false;
  const vistas = new Set();
  for (let pasta = journal.folder; pasta && !vistas.has(pasta.id); pasta = pasta.folder) {
    if (pasta.id === raiz.id) return true;
    vistas.add(pasta.id);
  }
  return false;
}
