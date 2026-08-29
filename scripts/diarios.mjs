/**
 * Anotações dos jogadores, montadas sobre os Journals nativos do Foundry.
 *
 * Uma pasta ("Anotações Jogadores") com um JournalEntry por jogador. Cada
 * jogador é OWNER do próprio diário e OBSERVER dos demais — é a permissão
 * nativa do Foundry que faz "todo mundo lê, só o dono escreve", então o
 * mestre pode reconfigurar isso pela interface dele e o app obedece sem
 * precisar saber de nada.
 *
 * Como as fichas, isto roda no client do mestre (ver relay.mjs): é ele quem
 * tem permissão de criar pasta e journals. Por isso toda escrita revalida o
 * dono no documento resolvido — nunca no que o front mandou.
 *
 * HTML, mas só o que passa pela peneira
 * -------------------------------------
 * A anotação é texto formatado (negrito, itálico, listas), como as descrições
 * que o app já exibe. O conteúdo que chega do front e o que sai do journal
 * passam os dois por `sanitizarHtml`: sem isso, um jogador poderia salvar um
 * `<script>` no próprio diário e ele rodaria no navegador de quem lesse — o
 * do mestre inclusive, que é quem executa o relay.
 */

import { MODULE_ID } from "./constantes.mjs";
import { sanitizarHtml, textoDoHtml } from "./html-seguro.mjs";

/** Nome da pasta no Foundry. O mestre pode movê-la; renomeá-la faz o módulo criar outra. */
export const NOME_PASTA = "Anotações Jogadores";

/** Onde guardamos de quem é o diário — sobrevive a renomear o usuário ou o journal. */
const FLAG_DONO = "donoId";

const SEM_DIARIO =
  "Você não tem um diário de anotações neste mundo — peça um ao mestre.";

const TITULO_MAX = 100;
const TEXTO_MAX = 20000;

/** Espaço entre os `sort` de duas páginas; o Foundry usa 100000 como densidade padrão. */
const DENSIDADE_ORDEM = 100000;

function niveis() {
  return CONST.DOCUMENT_OWNERSHIP_LEVELS;
}

/** Jogador de verdade: nem mestre (que já enxerga tudo), nem banido (papel "Nenhum"). */
function ehJogador(user) {
  return !user.isGM && user.role >= CONST.USER_ROLES.PLAYER;
}

// ---------------------------------------------------------------------------
// Pasta e diários
// ---------------------------------------------------------------------------

function pastaExistente() {
  return game.folders.find((pasta) => pasta.type === "JournalEntry" && pasta.name === NOME_PASTA) ?? null;
}

async function garantirPasta() {
  return pastaExistente() ?? (await Folder.create({ name: NOME_PASTA, type: "JournalEntry", sorting: "a" }));
}

function ownershipDe(user) {
  // Padrão OBSERVER: os outros jogadores leem o diário sem poder mexer nele.
  return { default: niveis().OBSERVER, [user.id]: niveis().OWNER };
}

/**
 * O diário do usuário, se já existir. Procura pela flag e, na falta dela, por
 * um journal com o nome do usuário dentro da pasta — assim uma organização
 * feita à mão pelo mestre é adotada em vez de duplicada.
 */
function acharDiario(user, pasta) {
  if (!pasta) return null;
  const daPasta = game.journal.filter((journal) => journal.folder?.id === pasta.id);
  return (
    daPasta.find((journal) => journal.getFlag(MODULE_ID, FLAG_DONO) === user.id) ??
    daPasta.find((journal) => journal.name === user.name) ??
    null
  );
}

/**
 * Criações em andamento, por usuário. Duas mensagens do mesmo jogador quase
 * simultâneas (abrir a tela e criar a primeira anotação) passariam as duas
 * pelo `acharDiario` antes de qualquer uma terminar — e ele acabaria com dois
 * diários.
 */
const criacoesEmVoo = new Map();

/**
 * O diário do usuário, criando pasta e journal se ainda não existirem —
 * `null` para quem não é jogador.
 *
 * O mestre não ganha diário automático de propósito: ele é OWNER de tudo, e
 * um journal "todos leem" criado sem ele pedir exporia anotações de mestre
 * para a mesa inteira. Se ele quiser um, cria à mão na pasta com o nome do
 * usuário dele — o caminho de adoção acima assume dali em diante, com o
 * ownership que ele mesmo escolher.
 */
export async function garantirDiario(user) {
  const existente = acharDiario(user, pastaExistente());
  if (existente) {
    // Adotado pelo nome: a flag garante que renomear o usuário depois não
    // faça o módulo perder o diário dele.
    if (existente.getFlag(MODULE_ID, FLAG_DONO) !== user.id) {
      await existente.setFlag(MODULE_ID, FLAG_DONO, user.id);
      if (!existente.testUserPermission(user, "OWNER")) await existente.update({ ownership: ownershipDe(user) });
    }
    return existente;
  }

  if (!ehJogador(user)) return null;

  const emVoo = criacoesEmVoo.get(user.id);
  if (emVoo) return emVoo;

  const criacao = (async () => {
    const pasta = await garantirPasta();
    // Reconfere agora que a pasta existe: entre a checagem lá em cima e este
    // ponto houve um await.
    return (
      acharDiario(user, pasta) ??
      (await JournalEntry.create({
        name: user.name,
        folder: pasta.id,
        ownership: ownershipDe(user),
        flags: { [MODULE_ID]: { [FLAG_DONO]: user.id } }
      }))
    );
  })().finally(() => criacoesEmVoo.delete(user.id));

  criacoesEmVoo.set(user.id, criacao);
  return criacao;
}

/**
 * Pasta e um diário por jogador. Chamado uma vez quando o mestre abre o
 * mundo: quem entrar pelo app já encontra o próprio diário pronto, sem
 * depender de ter aberto a tela alguma vez.
 */
export async function garantirEstrutura() {
  const jogadores = game.users.filter(ehJogador);
  if (!jogadores.length) return;
  await garantirPasta();
  for (const jogador of jogadores) await garantirDiario(jogador);
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

function paginasVisiveis(journal, user) {
  return [...journal.pages]
    .filter((pagina) => pagina.type === "text" && pagina.testUserPermission(user, "OBSERVER"))
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .map((pagina) => ({
      id: pagina.id,
      titulo: pagina.name,
      conteudo: sanitizarHtml(pagina.text?.content)
    }));
}

/**
 * Este diário é o *dele*? Vem da flag, não da permissão: o mestre é OWNER de
 * tudo no mundo, e por permissão os diários dos jogadores todos apareceriam
 * como dele na tela.
 */
function ehDono(journal, user) {
  return journal.getFlag(MODULE_ID, FLAG_DONO) === user.id;
}

/**
 * Todos os diários que o usuário pode ler, o dele primeiro. As páginas vão
 * inteiras junto: são alguns KB de texto, e um protocolo de "abrir página"
 * custaria mais complexidade do que economiza (mesmo raciocínio da ficha).
 */
export function listarDiarios(user) {
  const pasta = pastaExistente();
  if (!pasta) return [];
  return game.journal
    .filter((journal) => journal.folder?.id === pasta.id && journal.testUserPermission(user, "OBSERVER"))
    .map((journal) => ({
      id: journal.id,
      nome: journal.name,
      // Dono e com permissão de escrita: se o mestre rebaixar o ownership de
      // um diário, a tela para de oferecer edição — e o módulo recusaria
      // mesmo assim.
      meu: ehDono(journal, user) && journal.testUserPermission(user, "OWNER"),
      paginas: paginasVisiveis(journal, user)
    }))
    .sort((a, b) => Number(b.meu) - Number(a.meu) || a.nome.localeCompare(b.nome, "pt-BR"));
}

// ---------------------------------------------------------------------------
// Escrita — sempre no diário do próprio usuário
// ---------------------------------------------------------------------------

function validarTitulo(titulo) {
  const limpo = String(titulo ?? "").trim().slice(0, TITULO_MAX);
  if (!limpo) throw new Error("A anotação precisa de um título.");
  return limpo;
}

/**
 * Devolve o HTML já podado. O limite é medido no texto visível, não na
 * marcação: contar as tags faria uma anotação curta em listas estourar antes
 * de uma longa em parágrafos corridos.
 */
function validarConteudo(conteudo) {
  const limpo = sanitizarHtml(conteudo);
  if (textoDoHtml(limpo).length > TEXTO_MAX) {
    throw new Error(`Anotação muito longa (limite de ${TEXTO_MAX.toLocaleString("pt-BR")} caracteres).`);
  }
  return limpo;
}

/**
 * A página, resolvida *dentro* do diário do usuário. É o que torna
 * impossível editar a página de outro jogador mandando o id dela: uma página
 * alheia simplesmente não está nesta coleção.
 */
async function paginaDoUsuario(user, paginaId) {
  const diario = await garantirDiario(user);
  if (!diario) throw new Error(SEM_DIARIO);
  if (!diario.testUserPermission(user, "OWNER")) {
    throw new Error("Este diário não é seu — você pode ler, mas não editar.");
  }
  const pagina = diario.pages.get(paginaId);
  if (!pagina) throw new Error("Anotação não encontrada no seu diário.");
  return pagina;
}

export async function criarPagina(user, titulo, conteudo) {
  const nome = validarTitulo(titulo);
  const html = validarConteudo(conteudo);
  const diario = await garantirDiario(user);
  if (!diario) throw new Error(SEM_DIARIO);
  if (!diario.testUserPermission(user, "OWNER")) {
    throw new Error("Este diário não é seu — você pode ler, mas não editar.");
  }

  const ultimoSort = [...diario.pages].reduce((maior, pagina) => Math.max(maior, pagina.sort ?? 0), 0);
  const [pagina] = await diario.createEmbeddedDocuments("JournalEntryPage", [
    {
      name: nome,
      type: "text",
      title: { show: true, level: 1 },
      text: { content: html, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
      sort: ultimoSort + DENSIDADE_ORDEM
    }
  ]);
  return pagina?.id ?? null;
}

export async function salvarPagina(user, paginaId, titulo, conteudo) {
  const nome = validarTitulo(titulo);
  const html = validarConteudo(conteudo);
  const pagina = await paginaDoUsuario(user, paginaId);
  await pagina.update({ name: nome, "text.content": html });
}

export async function excluirPagina(user, paginaId) {
  const pagina = await paginaDoUsuario(user, paginaId);
  await pagina.delete();
}

/** Esta mudança de journal mexe em alguma anotação? Filtra ruído de outras pastas do mundo. */
export function ehDaPastaDeAnotacoes(journal) {
  const pasta = pastaExistente();
  return !!pasta && journal?.folder?.id === pasta.id;
}
