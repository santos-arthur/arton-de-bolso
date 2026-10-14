/**
 * Relay: transforma o Foundry num "servidor" para o front-end standalone
 * (projeto irmão `arton-de-bolso-frontend/`).
 *
 * Um módulo Foundry não roda fora de um client carregado — não existe
 * "backend" nosso ouvindo porta nenhuma. O que existe é o canal de socket
 * custom do próprio Foundry (`"socket": true` no module.json → evento
 * `module.arton-de-bolso`, ver `packages/package.mjs#registerCustomSocket`
 * no código-fonte do Foundry): qualquer socket autenticado (sessão válida,
 * inclusive uma conexão que não seja um client Foundry completo) recebe e
 * pode emitir nesse canal. Este arquivo só executa a lógica de retransmissão
 * dentro do client do **mestre** (`game.user.isGM`) — é o mestre quem
 * precisa estar com o Foundry aberto para o relay funcionar, porque só um
 * client carregado de verdade executa módulos.
 *
 * Protocolo (mensagens JSON trocadas em `module.arton-de-bolso`):
 *   Front → Foundry:
 *     { tipo: "obterFicha" }
 *     { tipo: "obterPersonagens" }
 *     { tipo: "selecionarPersonagem", actorId }
 *     { tipo: "ajustarPV" | "ajustarPM", delta }
 *     { tipo: "definirAtual" | "definirTemporario", recurso: "pv"|"pm", valor }
 *     { tipo: "alternarEquipado", itemId }
 *     { tipo: "alternarCarregado", itemId }
 *     { tipo: "ajustarQuantidade", itemId, delta }
 *     { tipo: "alternarPreparada", magiaId }
 *     { tipo: "equiparEmSlot", itemId, contexto: "hand"|"body", indice, idAtual }
 *     { tipo: "ajustarDinheiro", moeda, valor }
 *     { tipo: "descansar", opcoes }
 *     { tipo: "gastarUso", uso: { acao, pm, itens: [{ itemId, quantidade }] } }
 *     { tipo: "removerEfeito", efeitoId }
 *     { tipo: "obterDiarios" }
 *     { tipo: "criarPaginaDiario", titulo, conteudo }
 *     { tipo: "salvarPaginaDiario", paginaId, titulo, conteudo }
 *     { tipo: "excluirPaginaDiario", paginaId }
 *     { tipo: "obterCompendio" }
 *     { tipo: "obterCombate" }
 *     { tipo: "definirIniciativa", d20, aprimoramentos: [{ id, vezes }] }
 *     { tipo: "obterNegocios" }
 *     { tipo: "renderNegocio", negocioId, pericia?, d20? }
 *     { tipo: "movimentarCofre", negocioId, operacao: "sacar"|"depositar", quantia }
 *     { tipo: "obterBases" }
 *     { tipo: "iniciarAventuraBase", baseId, pagar, danificarId? }
 *     { tipo: "repararComodo", baseId, comodoId }
 *     { tipo: "apurarEmpreendimento", baseId, d20, dedicado }
 *   Foundry → Front (sempre só para o userId a quem a mensagem diz respeito):
 *     { tipo: "personagens", meus: [...], companheiros: [...] }
 *     { tipo: "ficha", ficha: <getFichaCompleta + somenteLeitura> }
 *     { tipo: "semFicha" }
 *     { tipo: "diarios", diarios: [{ id, nome, meu, paginas: [...] }] }
 *     { tipo: "compendio", compendio: { pastas: [...], journals: [{ id, nome, paginas: [...] }] } }
 *     { tipo: "combate", combate: { ativo, rodada, comecou, combatentes: [...] } }
 *     { tipo: "negocios", negocios: { disponivel, negocios: [...], pericias: [...] } }
 *     { tipo: "bases", bases: { disponivel, bases: [...] } }
 *     { tipo: "erro", mensagem }
 *
 * Autorização: cada mensagem chega com o userId de quem enviou, verificado
 * pelo próprio servidor do Foundry (não é um campo que o front possa
 * forjar — ver `handleCustomSocket` em sockets.mjs). Duas permissões
 * distintas, ambas nativas do Foundry:
 *   - OWNER   → "Meus Personagens": lê e escreve.
 *   - OBSERVER (sem OWNER) → "Companheiros": lê a ficha, nunca escreve.
 * Toda escrita revalida OWNER no ator resolvido antes de tocar em qualquer
 * dado — a checagem não depende de nada que venha do front.
 *
 * Os diários seguem a mesma ideia com as permissões do JournalEntry: o
 * jogador é OWNER do próprio e OBSERVER dos outros, e toda escrita é
 * resolvida *dentro* do diário dele (ver diarios.mjs). O compêndio (compendio.mjs)
 * é só leitura: cada item aparece para quem o mestre deu Observador, e some
 * da lista de quem ele tirar.
 */

import { MODULE_ID } from "./constantes.mjs";
import * as adaptador from "./adaptador-tormenta20.mjs";
import * as diarios from "./diarios.mjs";
import * as compendio from "./compendio.mjs";
import * as combate from "./combate.mjs";
import * as negocios from "./negocios.mjs";
import * as bases from "./bases.mjs";
import { MODULE_ID as ID_DO_MODULO } from "./constantes.mjs";

const EVENTO = `module.${MODULE_ID}`;

/**
 * Tipos que o front pode pedir. Tudo que não estiver aqui é ignorado — e isso
 * não é zelo: o canal é o mesmo nos dois sentidos, e o Foundry entrega o que
 * o relay emite a *todos* os sockets do destinatário. Quando o mestre usa o
 * app com o próprio usuário, o client dele recebe de volta a resposta que
 * acabou de mandar. Sem esta lista, uma mensagem "personagens" caía no
 * `if (!actor) enviarEstado(user)` lá embaixo e virava resposta à própria
 * resposta, em loop.
 */
const TIPOS_DO_FRONT = new Set([
  "obterFicha",
  "obterPersonagens",
  "selecionarPersonagem",
  "ajustarPV",
  "ajustarPM",
  "definirAtual",
  "definirTemporario",
  "alternarEquipado",
  "alternarCarregado",
  "ajustarQuantidade",
  "alternarPreparada",
  "equiparEmSlot",
  "ajustarDinheiro",
  "descansar",
  "gastarUso",
  "removerEfeito",
  "obterDiarios",
  "criarPaginaDiario",
  "salvarPaginaDiario",
  "excluirPaginaDiario",
  "obterCompendio",
  "obterCombate",
  "definirIniciativa",
  "obterNegocios",
  "renderNegocio",
  "movimentarCofre",
  "obterBases",
  "iniciarAventuraBase",
  "repararComodo",
  "apurarEmpreendimento"
]);

/**
 * Anotações não têm nada com o personagem aberto — quem manda nelas é a
 * permissão do JournalEntry, não a do ator. Por isso saem do fluxo antes de
 * `resolverAtor`: um jogador sem ficha nenhuma continua tendo diário.
 */
const TIPOS_DE_DIARIO = new Set([
  "obterDiarios",
  "criarPaginaDiario",
  "salvarPaginaDiario",
  "excluirPaginaDiario"
]);

/** Tipos que alteram dados do ator — exigem OWNER, não só OBSERVER. */
const TIPOS_ESCRITA = new Set([
  "ajustarPV",
  "ajustarPM",
  "definirAtual",
  "definirTemporario",
  "alternarEquipado",
  "alternarCarregado",
  "ajustarQuantidade",
  "alternarPreparada",
  "equiparEmSlot",
  "ajustarDinheiro",
  "descansar",
  "gastarUso",
  "removerEfeito",
  // Escreve no combatente, não no ator — mas quem manda na iniciativa de um
  // personagem é quem manda no personagem.
  "definirIniciativa",
  // Escreve no negócio, que tem posse própria — `negocios.renderNegocio`
  // confere as duas: a do personagem aqui e a do negócio lá.
  "renderNegocio",
  // Mexe no cofre do negócio e na bolsa do personagem ao mesmo tempo.
  "movimentarCofre",
  // Escrevem na base, que também tem posse própria — `bases.mjs` confere se
  // quem pede administra a base, além do OWNER do personagem aqui.
  "iniciarAventuraBase",
  "repararComodo",
  "apurarEmpreendimento"
]);

function warn(mensagem) {
  console.warn(`${MODULE_ID} | ${mensagem}`);
}

/** Escolha manual de personagem por usuário — só existe em memória, dura enquanto o client do mestre estiver aberto. */
const personagemSelecionado = new Map();

/** Resumo leve de um ator: o bastante para os cards da home do front, sem montar a ficha inteira. */
function resumoPersonagem(actor) {
  return {
    id: actor.id,
    nome: actor.name,
    img: actor.img,
    nivel: adaptador.getNivel(actor),
    raca: adaptador.getRaca(actor),
    classes: adaptador.getClasses(actor),
    dinheiroEmTibar: adaptador.getDinheiroEmTibar(actor)
  };
}

function personagensComPermissao(user, nivel) {
  return game.actors.filter((a) => a.type === "character" && a.testUserPermission(user, nivel));
}

/**
 * Duas listas da home: "meus" (posso editar) e "companheiros" (só enxergo).
 * Ordenadas por nome porque `game.actors` não garante ordem estável — e o
 * front usa o primeiro item de "meus" como atalho fixo pro personagem
 * principal, que não pode trocar sozinho entre um carregamento e outro.
 */
function listaDePersonagens(user) {
  const meus = [];
  const companheiros = [];
  for (const actor of personagensComPermissao(user, "OBSERVER")) {
    (actor.testUserPermission(user, "OWNER") ? meus : companheiros).push(resumoPersonagem(actor));
  }
  const porNome = (a, b) => a.nome.localeCompare(b.nome, "pt-BR");
  return { meus: meus.sort(porNome), companheiros: companheiros.sort(porNome) };
}

/**
 * Resolve qual ator o usuário está vendo agora: escolha manual > personagem
 * atribuído > único personagem que possui. A escolha manual aceita OBSERVER
 * (é como um companheiro é aberto); os dois fallbacks continuam sendo
 * personagens próprios, pra ninguém cair num companheiro sem pedir.
 */
function resolverAtor(user) {
  const escolhidoId = personagemSelecionado.get(user.id);
  if (escolhidoId) {
    const escolhido = game.actors.get(escolhidoId);
    if (escolhido && escolhido.testUserPermission(user, "OBSERVER")) return escolhido;
    personagemSelecionado.delete(user.id);
  }
  if (user.character?.testUserPermission(user, "OWNER")) return user.character;
  const meus = personagensComPermissao(user, "OWNER");
  return meus.length === 1 ? meus[0] : null;
}

function enviar(userIds, mensagem) {
  const recipients = Array.isArray(userIds) ? userIds : [userIds];
  if (!recipients.length) return;
  game.socket.emit(EVENTO, mensagem, { recipients });
}

// ---------------------------------------------------------------------------
// Notificação: agrupada e sob demanda
//
// O Foundry dispara `updateActor`/`updateItem` em rajada (um descanso mexe em
// PV, PM e vários itens de uma vez). Recalcular tudo para todos os usuários em
// cada hook faz o client do mestre travar: `listaDePersonagens` varre o elenco
// inteiro e `getClasses` percorre os itens de cada ator — multiplicado pelo
// número de usuários do mundo, e de novo a cada evento da rajada.
//
// Então nada é enviado direto do hook. Os hooks só anotam o que ficou sujo e
// uma única passada agrupada resolve tudo:
//   - a ficha é montada UMA vez por ator (dono e observador só diferem na flag
//     `somenteLeitura`);
//   - as listas só são recalculadas quando muda algo que aparece nelas (nome,
//     imagem, posse, nível/classe, elenco) — nunca por causa de um PV;
//   - listas idênticas à última enviada não viram tráfego.
// ---------------------------------------------------------------------------

const INTERVALO_AGRUPAMENTO_MS = 150;

/** Ids de atores cuja ficha mudou desde a última passada. */
const atoresPendentes = new Set();
/** Ids de usuários que precisam do estado inteiro (trocaram de personagem). */
const usuariosPendentes = new Set();
let listasSujas = false;
let passagemAgendada = null;

/** Última lista e última ficha enviadas a cada usuário, serializadas — evita reemitir JSON idêntico. */
const ultimaListaEnviada = new Map();
const ultimaFichaEnviada = new Map();
const ultimosDiariosEnviados = new Map();
const ultimoCompendioEnviado = new Map();
const ultimoCombateEnviado = new Map();
const ultimosNegociosEnviados = new Map();
const ultimasBasesEnviadas = new Map();

/**
 * Quem já pediu os diários alguma vez — e portanto tem a tela de anotações
 * aberta em algum lugar. Sem esta lista, cada anotação salva faria o client
 * do mestre montar e mandar o conjunto de diários para o mundo inteiro.
 */
const interessadosEmDiarios = new Set();
let diariosSujos = false;

/** Mesma ideia para o compêndio — quem abriu a tela dele. */
const interessadosEmCompendio = new Set();
let compendioSujo = false;

/**
 * E para o combate. Aqui a inscrição importa mais que nas outras: a ordem de
 * combate muda a cada turno, e uma mesa em luta geraria um push por passagem
 * de turno para o mundo inteiro se não fosse só para quem abriu a tela.
 */
const interessadosEmCombate = new Set();
let combateSujo = false;

/**
 * E para os negócios. Diferente do combate, a lista depende de quem olha: são
 * os negócios do personagem aberto, com o bônus de perícia dele — por isso é
 * montada por usuário, e trocar de personagem também a reenvia.
 */
const interessadosEmNegocios = new Set();
let negociosSujos = false;

/**
 * E para as bases, pelo mesmo motivo: a lista é do personagem aberto — as
 * bases dele, e o que cada uma dá a ele como residente.
 */
const interessadosEmBases = new Set();
let basesSujas = false;

function agendarPassagem() {
  if (passagemAgendada) return;
  passagemAgendada = setTimeout(() => {
    passagemAgendada = null;
    try {
      processarPendencias();
    } catch (erro) {
      warn(`Falha ao empurrar atualizações: ${erro.message}`);
    }
  }, INTERVALO_AGRUPAMENTO_MS);
}

function marcarAtor(actor) {
  if (actor?.type !== "character") return;
  atoresPendentes.add(actor.id);
  agendarPassagem();
}

/**
 * O ator dono de um efeito. `getEfeitos` lê `allApplicableEffects()`, que
 * junta os efeitos postos direto na ficha com os que moram nos itens dela —
 * então o pai do efeito tanto pode ser o próprio ator quanto um item dele.
 */
function atorDoEfeito(efeito) {
  const pai = efeito?.parent;
  if (!pai) return null;
  return pai.documentName === "Actor" ? pai : (pai.parent ?? null);
}

function marcarListas() {
  listasSujas = true;
  agendarPassagem();
}

function marcarUsuario(user) {
  if (!user) return;
  usuariosPendentes.add(user.id);
  agendarPassagem();
}

function marcarDiarios() {
  if (!interessadosEmDiarios.size) return;
  diariosSujos = true;
  agendarPassagem();
}

function marcarCompendio() {
  if (!interessadosEmCompendio.size) return;
  compendioSujo = true;
  agendarPassagem();
}

function marcarCombate() {
  if (!interessadosEmCombate.size) return;
  combateSujo = true;
  agendarPassagem();
}

function marcarNegocios() {
  if (!interessadosEmNegocios.size) return;
  negociosSujos = true;
  agendarPassagem();
}

function marcarBases() {
  if (!interessadosEmBases.size) return;
  basesSujas = true;
  agendarPassagem();
}

/** Envia a lista só se ela mudou de verdade (ou se o front pediu explicitamente). */
function enviarLista(user, forcar = false) {
  const listas = listaDePersonagens(user);
  const serializada = JSON.stringify(listas);
  if (!forcar && ultimaListaEnviada.get(user.id) === serializada) return;
  ultimaListaEnviada.set(user.id, serializada);
  enviar(user.id, { tipo: "personagens", ...listas });
}

/**
 * A ficha inteira vai a cada mudança — medido no mundo real, o payload fica
 * entre 4 e 18 KB por personagem, então um protocolo de delta custaria muito
 * mais complexidade do que economiza. O que vale a pena é não reenviar um
 * payload idêntico: `updateActor` dispara por coisas que não aparecem na
 * ficha, e cada uma dessas viraria tráfego à toa.
 */
function enviarFichaMontada(user, ficha, forcar) {
  const serializada = JSON.stringify(ficha);
  if (!forcar && ultimaFichaEnviada.get(user.id) === serializada) return;
  ultimaFichaEnviada.set(user.id, serializada);
  enviar(user.id, { tipo: "ficha", ficha });
}

function enviarFicha(user, ator, forcar = false) {
  // `ator` omitido = resolve na hora; passado (mesmo null) = já foi resolvido
  // pelo chamador, que não deve pagar a resolução duas vezes.
  const actor = ator === undefined ? resolverAtor(user) : ator;
  if (!actor) {
    ultimaFichaEnviada.delete(user.id);
    enviar(user.id, { tipo: "semFicha" });
    return;
  }
  // `somenteLeitura` é decidido aqui, no client do mestre, e viaja junto da
  // ficha — o front usa só pra esconder controle, nunca como autorização
  // (quem autoriza é o TIPOS_ESCRITA + OWNER lá embaixo).
  const ficha = adaptador.getFichaCompleta(actor);
  ficha.somenteLeitura = !actor.testUserPermission(user, "OWNER");
  ficha.modulos = modulosDisponiveis();
  enviarFichaMontada(user, ficha, forcar);
}

/**
 * Os diários que este usuário pode ler, com as páginas inteiras. Mesmo
 * critério de tráfego da ficha: só sai o que mudou de verdade.
 */
function enviarDiarios(user, forcar = false) {
  const lista = diarios.listarDiarios(user);
  const serializada = JSON.stringify(lista);
  if (!forcar && ultimosDiariosEnviados.get(user.id) === serializada) return;
  ultimosDiariosEnviados.set(user.id, serializada);
  enviar(user.id, { tipo: "diarios", diarios: lista });
}

/**
 * O compêndio liberado para este jogador. Note que a lista muda sozinha quando o
 * mestre mexe na posse de um journal: é assim que "mostrar isto à mesa" chega
 * à tela, sem passo nenhum de publicação.
 */
function enviarCompendio(user, forcar = false) {
  const lista = compendio.listarCompendio(user);
  const serializada = JSON.stringify(lista);
  if (!forcar && ultimoCompendioEnviado.get(user.id) === serializada) return;
  ultimoCompendioEnviado.set(user.id, serializada);
  enviar(user.id, { tipo: "compendio", compendio: lista });
}

/**
 * O combate é o mesmo para todo mundo — rodada, ordem e turno não mudam com
 * quem olha —, então a lista é montada uma vez por passada e só o filtro de
 * "já mandei isto" é por usuário. Quem esconde o próprio PV/PM na linha da
 * ficha aberta é a tela, que sabe qual ficha está aberta.
 */
function enviarCombate(user, lista, forcar = false) {
  const serializada = JSON.stringify(lista);
  if (!forcar && ultimoCombateEnviado.get(user.id) === serializada) return;
  ultimoCombateEnviado.set(user.id, serializada);
  enviar(user.id, { tipo: "combate", combate: lista });
}

/**
 * Os negócios do personagem que este usuário está olhando. `ator` segue a
 * mesma convenção de `enviarFicha`: omitido, resolve na hora.
 */
function enviarNegocios(user, ator, forcar = false) {
  const actor = ator === undefined ? resolverAtor(user) : ator;
  const estado = negocios.listarNegocios(actor, user);
  const serializada = JSON.stringify(estado);
  if (!forcar && ultimosNegociosEnviados.get(user.id) === serializada) return;
  ultimosNegociosEnviados.set(user.id, serializada);
  enviar(user.id, { tipo: "negocios", negocios: estado });
}

/** As bases do personagem que este usuário está olhando — mesma convenção. */
function enviarBases(user, ator, forcar = false) {
  const actor = ator === undefined ? resolverAtor(user) : ator;
  const estado = bases.listarBases(actor, user);
  const serializada = JSON.stringify(estado);
  if (!forcar && ultimasBasesEnviadas.get(user.id) === serializada) return;
  ultimasBasesEnviadas.set(user.id, serializada);
  enviar(user.id, { tipo: "bases", bases: estado });
}

/**
 * Os módulos irmãos que liberam telas no app. Vai junto da ficha: ligar ou
 * desligar um módulo exige recarregar o Foundry, então não há hook para isso
 * — a próxima ficha montada já sai com o valor certo.
 */
function modulosDisponiveis() {
  return { negocios: negocios.disponivel(), bases: bases.disponivel() };
}

/** Resposta a um pedido explícito do front: manda tudo, mesmo que nada tenha mudado. */
function enviarEstado(user) {
  enviarLista(user, true);
  enviarFicha(user, undefined, true);
  if (interessadosEmNegocios.has(user.id)) enviarNegocios(user, undefined, true);
  if (interessadosEmBases.has(user.id)) enviarBases(user, undefined, true);
}

function enviarErro(userId, mensagem) {
  enviar(userId, { tipo: "erro", mensagem });
}

function processarPendencias() {
  const atores = [...atoresPendentes];
  const usuarios = [...usuariosPendentes];
  const recalcularListas = listasSujas;
  const recalcularDiarios = diariosSujos;
  const recalcularCompendio = compendioSujo;
  const recalcularCombate = combateSujo;
  const recalcularNegocios = negociosSujos;
  const recalcularBases = basesSujas;
  atoresPendentes.clear();
  usuariosPendentes.clear();
  listasSujas = false;
  diariosSujos = false;
  compendioSujo = false;
  combateSujo = false;
  negociosSujos = false;
  basesSujas = false;

  const todos = [...game.users];

  if (recalcularDiarios) {
    for (const userId of interessadosEmDiarios) {
      const user = game.users.get(userId);
      if (user) enviarDiarios(user);
    }
  }

  if (recalcularCompendio) {
    for (const userId of interessadosEmCompendio) {
      const user = game.users.get(userId);
      if (user) enviarCompendio(user);
    }
  }

  if (recalcularCombate) {
    const lista = combate.listarCombate();
    for (const userId of interessadosEmCombate) {
      const user = game.users.get(userId);
      if (user) enviarCombate(user, lista);
    }
  }

  // resolverAtor pode varrer o elenco inteiro (usuário sem personagem
  // atribuído nem escolha manual), então é resolvido no máximo uma vez por
  // usuário por passada — e só para quem tem permissão no ator que mudou.
  const memoAtor = new Map();
  const atorDe = (user) => {
    if (!memoAtor.has(user.id)) memoAtor.set(user.id, resolverAtor(user));
    return memoAtor.get(user.id);
  };

  if (recalcularListas) {
    for (const user of todos) enviarLista(user);
  }

  // Quem trocou de personagem recebe o estado inteiro; fica marcado pra não
  // receber a mesma ficha de novo no laço seguinte.
  const jaAtendidos = new Set();
  for (const userId of usuarios) {
    const user = game.users.get(userId);
    if (!user) continue;
    enviarLista(user, true);
    enviarFicha(user, atorDe(user), true);
    if (interessadosEmNegocios.has(userId)) enviarNegocios(user, atorDe(user), true);
    if (interessadosEmBases.has(userId)) enviarBases(user, atorDe(user), true);
    jaAtendidos.add(userId);
  }

  // Depois do laço acima, que já mandou a lista a quem trocou de personagem;
  // aqui o filtro de "já mandei isto" segura o que não mudou.
  if (recalcularNegocios) {
    for (const userId of interessadosEmNegocios) {
      const user = game.users.get(userId);
      if (user) enviarNegocios(user, atorDe(user));
    }
  }

  if (recalcularBases) {
    for (const userId of interessadosEmBases) {
      const user = game.users.get(userId);
      if (user) enviarBases(user, atorDe(user));
    }
  }

  for (const actorId of atores) {
    const actor = game.actors.get(actorId);
    if (!actor) continue;

    // Quem não enxerga o ator nem entra na conta — evita resolver o
    // personagem de usuários que não têm nada a ver com esta mudança.
    const interessados = todos.filter(
      (user) =>
        !jaAtendidos.has(user.id) &&
        actor.testUserPermission(user, "OBSERVER") &&
        atorDe(user)?.id === actorId
    );
    if (!interessados.length) continue;

    // Uma montagem só serve pra todo mundo: entre dono e observador a única
    // diferença é a flag. getFichaCompleta é a parte cara (monta as fórmulas
    // de todas as perícias), então não pode rodar por destinatário.
    const base = { ...adaptador.getFichaCompleta(actor), modulos: modulosDisponiveis() };
    for (const user of interessados) {
      enviarFichaMontada(user, { ...base, somenteLeitura: !actor.testUserPermission(user, "OWNER") }, false);
    }
  }
}

/** Campos que aparecem nos cards da home — só eles justificam recalcular as listas. */
function mudancaAfetaListas(changes) {
  if (!changes) return false;
  return (
    "name" in changes ||
    "img" in changes ||
    "ownership" in changes ||
    !!changes.system?.attributes?.nivel ||
    !!changes.system?.dinheiro
  );
}

/**
 * Anotações do jogador. Toda escrita passa por diarios.mjs, que resolve a
 * página *dentro* do diário de quem pediu — o id vindo do front nunca serve
 * para achar um documento fora dali, então mandar o id de uma página alheia
 * não leva a lugar nenhum.
 */
async function tratarDiario(tipo, mensagem, user) {
  // Pedir os diários é o que inscreve o usuário no push: daqui em diante,
  // anotação criada por ele ou pelos colegas chega sozinha na tela.
  interessadosEmDiarios.add(user.id);

  try {
    switch (tipo) {
      case "obterDiarios":
        // Um usuário criado depois de o mundo subir não passou pelo
        // `garantirEstrutura` — o diário dele nasce aqui, na primeira visita.
        await diarios.garantirDiario(user);
        break;
      case "criarPaginaDiario":
        await diarios.criarPagina(user, mensagem.titulo, mensagem.conteudo);
        break;
      case "salvarPaginaDiario":
        await diarios.salvarPagina(user, mensagem.paginaId, mensagem.titulo, mensagem.conteudo);
        break;
      case "excluirPaginaDiario":
        await diarios.excluirPagina(user, mensagem.paginaId);
        break;
      default:
        warn(`Mensagem de diário com tipo desconhecido ignorada: "${tipo}"`);
    }
  } catch (erro) {
    warn(`Erro ao tratar "${tipo}" de ${user.name}: ${erro.message}`);
    enviarErro(user.id, erro.message);
  }

  // Responde mesmo depois de um erro: assim a tela do jogador volta ao que o
  // Foundry de fato tem, em vez de ficar exibindo um palpite que não vingou.
  enviarDiarios(user, true);
}

async function tratarMensagem(mensagem, senderUserId) {
  if (!game.user.isGM) return;

  const tipo = mensagem?.tipo;
  if (!TIPOS_DO_FRONT.has(tipo)) return;

  const user = game.users.get(senderUserId);
  if (!user) return;

  if (tipo === "obterPersonagens") {
    enviarLista(user);
    return;
  }

  if (tipo === "selecionarPersonagem") {
    const actor = game.actors.get(mensagem.actorId);
    if (actor?.testUserPermission(user, "OBSERVER")) personagemSelecionado.set(senderUserId, actor.id);
    else enviarErro(senderUserId, "Você não tem permissão para ver este personagem.");
    enviarEstado(user);
    return;
  }

  if (tipo === "obterFicha") {
    enviarEstado(user);
    return;
  }

  if (tipo === "obterCompendio") {
    // Pedir é o que inscreve no push: a partir daqui, o que o mestre liberar
    // aparece na tela sozinho.
    interessadosEmCompendio.add(user.id);
    enviarCompendio(user, true);
    return;
  }

  if (tipo === "obterCombate") {
    // Idem: quem abriu a tela de combate passa a receber cada virada de turno.
    interessadosEmCombate.add(user.id);
    enviarCombate(user, combate.listarCombate(), true);
    return;
  }

  if (TIPOS_DE_DIARIO.has(tipo)) {
    await tratarDiario(tipo, mensagem, user);
    return;
  }

  // Inscreve antes de resolver o personagem: quem ainda não escolheu um (F5
  // com mais de um personagem próprio) recebe a lista assim que escolher —
  // `enviarEstado` já a inclui para os inscritos.
  if (tipo === "obterNegocios") interessadosEmNegocios.add(user.id);
  if (tipo === "obterBases") interessadosEmBases.add(user.id);

  const actor = resolverAtor(user);
  if (!actor) {
    enviarEstado(user);
    return;
  }

  if (tipo === "obterNegocios") {
    // Já inscrito lá em cima: o rendimento apurado, o ativo que o mestre
    // contratou ou o nível que subiu chegam sozinhos na tela.
    enviarNegocios(user, actor, true);
    return;
  }

  if (tipo === "obterBases") {
    enviarBases(user, actor, true);
    return;
  }

  if (TIPOS_ESCRITA.has(tipo) && !actor.testUserPermission(user, "OWNER")) {
    enviarErro(senderUserId, `${actor.name} não é seu personagem — esta ficha é somente leitura.`);
    return;
  }

  try {
    switch (tipo) {
      case "ajustarPV": {
        const delta = Number(mensagem.delta) || 0;
        if (delta > 0) await adaptador.curarPV(actor, delta);
        else if (delta < 0) await adaptador.gastarPV(actor, Math.abs(delta));
        break;
      }
      case "ajustarPM": {
        const delta = Number(mensagem.delta) || 0;
        if (delta > 0) await adaptador.recuperarPM(actor, delta);
        else if (delta < 0) await adaptador.gastarPM(actor, Math.abs(delta));
        break;
      }
      case "definirAtual": {
        await adaptador.definirAtual(actor, mensagem.recurso, Number(mensagem.valor) || 0);
        break;
      }
      case "definirTemporario": {
        await adaptador.definirTemporario(actor, mensagem.recurso, Number(mensagem.valor) || 0);
        break;
      }
      case "alternarEquipado": {
        await adaptador.alternarEquipado(actor, mensagem.itemId);
        break;
      }
      case "alternarCarregado": {
        await adaptador.alternarCarregado(actor, mensagem.itemId);
        break;
      }
      case "ajustarQuantidade": {
        await adaptador.ajustarQuantidade(actor, mensagem.itemId, mensagem.delta);
        break;
      }
      case "alternarPreparada": {
        await adaptador.alternarPreparada(actor, mensagem.magiaId);
        break;
      }
      case "equiparEmSlot": {
        await adaptador.equiparEmSlot(
          actor,
          mensagem.itemId,
          mensagem.contexto,
          Number(mensagem.indice) || 0,
          mensagem.idAtual ?? null
        );
        break;
      }
      case "ajustarDinheiro": {
        await adaptador.ajustarDinheiro(actor, mensagem.moeda, mensagem.valor);
        break;
      }
      case "descansar": {
        await adaptador.descansar(actor, mensagem.opcoes ?? {});
        break;
      }
      // `user` vai junto porque a mensagem de chat sai em nome de quem
      // apertou o botão, não do mestre em cujo client isto roda.
      case "gastarUso": {
        await adaptador.gastarUso(actor, user, mensagem.uso ?? {});
        break;
      }
      case "removerEfeito": {
        await adaptador.removerEfeito(actor, mensagem.efeitoId);
        break;
      }
      case "definirIniciativa": {
        await combate.definirIniciativa(actor, {
          d20: mensagem.d20,
          aprimoramentos: mensagem.aprimoramentos
        });
        break;
      }
      case "renderNegocio": {
        await negocios.renderNegocio(actor, user, {
          negocioId: mensagem.negocioId,
          pericia: mensagem.pericia ?? null,
          d20: mensagem.d20 ?? null
        });
        break;
      }
      case "movimentarCofre": {
        await negocios.movimentarCofre(actor, user, {
          negocioId: mensagem.negocioId,
          operacao: mensagem.operacao,
          quantia: mensagem.quantia
        });
        break;
      }
      case "iniciarAventuraBase": {
        await bases.iniciarAventura(actor, user, {
          baseId: mensagem.baseId,
          pagar: mensagem.pagar === true,
          danificarId: mensagem.danificarId ?? null
        });
        break;
      }
      case "repararComodo": {
        await bases.repararComodo(actor, user, { baseId: mensagem.baseId, comodoId: mensagem.comodoId });
        break;
      }
      case "apurarEmpreendimento": {
        await bases.apurarEmpreendimento(actor, user, {
          baseId: mensagem.baseId,
          d20: mensagem.d20,
          dedicado: mensagem.dedicado === true
        });
        break;
      }
      default:
        warn(`Mensagem com tipo desconhecido ignorada: "${tipo}"`);
    }
  } catch (erro) {
    warn(`Erro ao tratar "${tipo}" de ${user.name}: ${erro.message}`);
    enviarErro(senderUserId, erro.message);
  }
  // Não precisa reenviar a ficha aqui: os Hooks abaixo (updateActor/*Item)
  // já disparam a partir da escrita acima e cobrem o push.
}

export function registrarRelay() {
  if (!game.user.isGM) return;

  game.socket.on(EVENTO, tratarMensagem);

  Hooks.on("updateActor", (actor, changes) => {
    marcarAtor(actor);
    // O negócio em si (cofre, nível, ativos) e o personagem dono dele (o
    // bônus de Nobreza e de Ofício). `marcarNegocios` não faz nada se ninguém
    // estiver com a tela aberta, e a lista igual à última não sai.
    if (negocios.ehNegocio(actor) || actor?.type === "character") marcarNegocios();
    // A base em si, e o personagem: nome, INT do Empreendimento, e — quando a
    // base vincula um negócio — o nível dele.
    if (bases.ehBase(actor) || actor?.type === "character" || negocios.ehNegocio(actor)) marcarBases();
    if (actor?.type === "character" && mudancaAfetaListas(changes)) marcarListas();
  });

  // Um item qualquer muda a ficha; só um item de classe muda o que a home
  // mostra (nível e classes no card).
  for (const evento of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(evento, (item) => {
      marcarAtor(item?.parent);
      if (item?.parent?.type === "character" && item.type === "classe") marcarListas();
      // Item e efeito mexem no bônus de Nobreza/Ofício que a tela de negócios mostra.
      if (item?.parent?.type === "character") marcarNegocios();
      // Cômodos e mobílias são Itens dentro da base.
      if (bases.ehBase(item?.parent)) marcarBases();
    });
  }

  // Ligar e desligar poder não passa por `updateActor` nem por `updateItem`:
  // um Active Effect é documento próprio, e mexer nele (a Fúria que acende, o
  // efeito que o mestre desabilita na ficha) não dispara os hooks acima. Sem
  // estes três, ativar um poder só chegava ao app de carona no `updateActor`
  // do PM gasto — e um poder que não custa nada não chegava de jeito nenhum.
  //
  // No Foundry v14 eles também cobrem o efeito que acaba sozinho: prazo
  // vencido, fim da cena, conjurador que parou de sustentar. O sistema manda
  // o core apagar o efeito nesses casos (`CONFIG.ActiveEffect.expiryAction`),
  // e é o `deleteActiveEffect` que leva a ficha nova pro celular.
  for (const evento of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
    Hooks.on(evento, (efeito) => {
      const ator = atorDoEfeito(efeito);
      marcarAtor(ator);
      if (ator?.type === "character") marcarNegocios();
      // Danificar e reparar ligam e desligam os efeitos dos cômodos.
      if (bases.ehBase(ator)) marcarBases();
    });
  }

  // Ligar a regra de negócios do Empreendimento muda como a base rende — sem
  // isto, a tela aberta só veria a troca no próximo push.
  Hooks.on("updateSetting", (configuracao) => {
    if (configuracao?.key === "t20-bases.empreendimentoComoNegocio") marcarBases();
  });

  Hooks.on("createActor", (actor) => {
    marcarListas();
    if (negocios.ehNegocio(actor)) marcarNegocios();
    if (bases.ehBase(actor)) marcarBases();
  });
  Hooks.on("deleteActor", (actor) => {
    marcarListas();
    if (negocios.ehNegocio(actor)) marcarNegocios();
    if (bases.ehBase(actor)) marcarBases();
  });

  // ---- Combate ---------------------------------------------------------------
  // Tudo que mexe no encontro: começar, passar o turno, entrar na ordem,
  // rolar iniciativa, sair da luta. `updateCombat` cobre rodada e turno;
  // os de Combatant, a ordem e a iniciativa.
  for (const evento of ["createCombat", "updateCombat", "deleteCombat"]) {
    Hooks.on(evento, () => marcarCombate());
  }
  for (const evento of ["createCombatant", "updateCombatant", "deleteCombatant"]) {
    Hooks.on(evento, () => marcarCombate());
  }
  // A lista carrega o PV/PM dos aliados e a barra dos inimigos, então o dano
  // que o mestre aplica na mesa precisa chegar nela — e isso é `updateActor`.
  // `marcarCombate` só faz algo se alguém estiver com a tela aberta.
  Hooks.on("updateActor", () => marcarCombate());
  // O mestre ligou ou desligou a barra de vida dos inimigos.
  Hooks.on(`${ID_DO_MODULO}.configuracaoMudou`, () => marcarCombate());

  // Só a troca do personagem atribuído muda o que o usuário vê — updateUser
  // dispara por muita coisa irrelevante (cor, flags, avatar).
  Hooks.on("updateUser", (user, changes) => {
    if (changes && "character" in changes) marcarUsuario(user);
  });

  // ---- Anotações e compêndio -------------------------------------------------
  // As duas pastas são criadas uma vez: a de anotações já com um diário por
  // jogador, a do compêndio vazia, esperando o que o mestre puser lá.
  diarios.garantirEstrutura().catch((erro) => warn(`Falha ao preparar as anotações: ${erro.message}`));
  compendio.garantirPasta().catch((erro) => warn(`Falha ao preparar a pasta do compêndio: ${erro.message}`));

  for (const evento of ["createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage"]) {
    Hooks.on(evento, (pagina) => {
      if (diarios.ehDaPastaDeAnotacoes(pagina?.parent)) marcarDiarios();
      if (compendio.ehDaPasta(pagina?.parent)) marcarCompendio();
    });
  }

  // O journal em si muda por menos coisas (nome, posse, exclusão) — mas é a
  // posse que libera um item para um jogador, então é justamente aqui que
  // "mostrar isto para a mesa" acontece.
  for (const evento of ["createJournalEntry", "updateJournalEntry", "deleteJournalEntry"]) {
    Hooks.on(evento, (journal) => {
      if (diarios.ehDaPastaDeAnotacoes(journal)) marcarDiarios();
      if (compendio.ehDaPasta(journal)) marcarCompendio();
    });
  }

  // Uma pasta que nasce, some ou muda de lugar reorganiza as duas telas — e
  // nesse caso as checagens acima já não têm como reconhecer nada, porque
  // dependem justamente da árvore de pastas. Mexer em pasta de journal é raro
  // o bastante para não valer um filtro mais fino.
  for (const evento of ["createFolder", "updateFolder", "deleteFolder"]) {
    Hooks.on(evento, (pasta) => {
      if (pasta?.type !== "JournalEntry") return;
      marcarDiarios();
      marcarCompendio();
    });
  }

  console.log(`${MODULE_ID} | Relay ativo em "${EVENTO}" (client do mestre)`);
}
