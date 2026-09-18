/**
 * O combate em andamento, como o app precisa vê-lo.
 *
 * O encontro é do **mundo**, não da ficha: rodada, ordem e turno são os
 * mesmos para todo mundo, e é por isso que este payload é montado uma vez só
 * e enviado igual a todos os jogadores (ver relay.mjs). O que cada um faz com
 * ele é decisão de tela — a ficha aberta, por exemplo, não repete PV/PM na
 * lista porque o cabeçalho já os mostra.
 *
 * O que **não** é igual para todos:
 *   - combatente escondido pelo mestre (`hidden`) não sai daqui de jeito
 *     nenhum. É o olho do mestre sobre a mesa, e o app não fura isso;
 *   - inimigo só mostra barra de vida se o mestre tiver ligado a opção do
 *     módulo (ver configuracoes.mjs), e mesmo assim sem número nenhum —
 *     é a proporção, que é o que se enxerga olhando para a criatura;
 *   - aliado mostra vida e mana com números, sempre. O grupo sabe como está
 *     o grupo.
 *
 * Como o resto do módulo, nada aqui rola dado: a iniciativa é o número que o
 * jogador leu no d20 da mesa, somado ao que a ficha já diz.
 */

import { mostrarVidaInimigos } from "./configuracoes.mjs";
import { getAprimoramentos } from "./adaptador-tormenta20.mjs";

/** A perícia que o sistema usa na fórmula de iniciativa (`_getInitiativeFormula`). */
const PERICIA_INICIATIVA = "inic";

/** A chave de `change` que um aprimoramento usa para somar num teste. */
const CHAVE_BONUS_DE_TESTE = "roll";

/** O encontro ativo da mesa, ou `null` quando ninguém iniciou combate. */
function combateAtivo() {
  return game.combats?.active ?? null;
}

/**
 * Aliado é o personagem de jogador e o que o mestre marcou como amigável no
 * token. O resto — hostil, neutro, sem token — conta como inimigo, que é o
 * lado conservador: na dúvida, o app mostra menos.
 */
function ehAliado(combatente) {
  if (combatente.actor?.type === "character") return true;
  const disposicao = combatente.token?.disposition;
  return disposicao === CONST.TOKEN_DISPOSITIONS.FRIENDLY;
}

/**
 * O ator do mundo por trás do combatente. Token não vinculado tem um ator
 * próprio, sintético, cujo id não é o do ator que o app abre — o `baseActor`
 * é o que liga os dois.
 */
function atorBase(combatente) {
  return combatente.token?.baseActor ?? combatente.actor ?? null;
}

function recurso(actor, chave) {
  const dado = actor?.system?.attributes?.[chave];
  if (!dado) return null;
  return {
    atual: Number(dado.value) || 0,
    max: Number(dado.max) || 0,
    temp: Number(dado.temp) || 0
  };
}

/** Quanto resta da vida, de 0 a 1 — o que a barra do inimigo desenha. */
function fracaoDeVida(actor) {
  const pv = recurso(actor, "pv");
  if (!pv?.max) return null;
  const cheio = pv.atual + pv.temp;
  return Math.max(0, Math.min(1, cheio / pv.max));
}

function mapearCombatente(combatente, { atualId, proximoId, comVidaInimiga }) {
  const aliado = ehAliado(combatente);
  const actor = combatente.actor;
  const base = atorBase(combatente);

  return {
    id: combatente.id,
    /** O ator que o app abre — é por ele que a tela reconhece "este sou eu". */
    atorId: base?.id ?? null,
    nome: combatente.name,
    img: combatente.img ?? actor?.img ?? "",
    /** `null` enquanto ninguém rolou — é o que faz o botão de d20 aparecer. */
    iniciativa: combatente.initiative ?? null,
    aliado,
    derrotado: !!combatente.isDefeated,
    ehAtual: combatente.id === atualId,
    ehProximo: combatente.id === proximoId,
    pv: aliado ? recurso(actor, "pv") : null,
    pm: aliado ? recurso(actor, "pm") : null,
    vidaFracao: !aliado && comVidaInimiga ? fracaoDeVida(actor) : null
  };
}

/**
 * O estado do combate para o app. `ativo: false` é o caso comum — mesa fora
 * de luta —, e a tela de Combate segue como sempre foi.
 */
export function listarCombate() {
  const combate = combateAtivo();
  if (!combate) return { ativo: false, rodada: 0, combatentes: [] };

  const atualId = combate.combatant?.id ?? null;
  const proximoId = combate.nextCombatant?.id ?? null;
  const comVidaInimiga = mostrarVidaInimigos();

  const combatentes = combate.turns
    .filter((combatente) => !combatente.hidden)
    .map((combatente) => mapearCombatente(combatente, { atualId, proximoId, comVidaInimiga }));

  return {
    ativo: true,
    /** Zero antes de o mestre apertar "Iniciar combate": os combatentes já estão lá, o relógio não. */
    rodada: combate.round ?? 0,
    comecou: !!combate.started,
    combatentes
  };
}

/** O combatente deste ator no encontro, seja o token vinculado ou não. */
function combatenteDoAtor(combate, actor) {
  return (
    combate.combatants.find((combatente) => atorBase(combatente)?.id === actor.id) ?? null
  );
}

/**
 * Soma dos aprimoramentos marcados que valem para o teste (`roll`), pelos ids
 * que o app mandou.
 *
 * Quem resolve o quanto cada um vale é o Foundry, não a tela: o app manda os
 * ids e quantas vezes cada um foi aplicado, e o número sai daqui — mesmo
 * princípio de `gastarUso`.
 */
function bonusDeAprimoramentos(actor, escolhas) {
  if (!Array.isArray(escolhas) || !escolhas.length) return 0;
  const porId = new Map(getAprimoramentos(actor).map((apr) => [apr.id, apr]));

  let total = 0;
  for (const escolha of escolhas) {
    const id = typeof escolha === "string" ? escolha : escolha?.id;
    const vezes = Math.max(1, Math.floor(Number(escolha?.vezes) || 1));
    const aprimoramento = porId.get(id);
    if (!aprimoramento) continue;
    const modificador = aprimoramento.modificadores.find(
      (m) => String(m.chave).toLowerCase() === CHAVE_BONUS_DE_TESTE
    );
    if (Number.isFinite(modificador?.valor)) total += modificador.valor * vezes;
  }
  return total;
}

/**
 * Grava a iniciativa do personagem no encontro.
 *
 * O `d20` é o dado que rolou na mesa — o app não rola nada, e é justamente
 * por isso que ele precisa ser digitado. O resto da conta é do Foundry: o
 * valor da perícia Iniciativa da ficha (que já traz atributo, treino,
 * efeitos) mais os aprimoramentos que o jogador marcou.
 *
 * Regravar é permitido de propósito: erro de digitação e rerrolagem na mesa
 * acontecem, e o combatente já existe no encontro de qualquer jeito.
 */
export async function definirIniciativa(actor, { d20, aprimoramentos } = {}) {
  const dado = Math.floor(Number(d20));
  if (!Number.isFinite(dado) || dado < 1 || dado > 20) {
    throw new Error("O resultado do d20 precisa ser um número de 1 a 20.");
  }

  const combate = combateAtivo();
  if (!combate) throw new Error("Não há combate em andamento.");

  const combatente = combatenteDoAtor(combate, actor);
  if (!combatente) throw new Error(`${actor.name} não está neste combate — peça ao mestre para adicionar.`);

  const pericia = Number(actor.system?.pericias?.[PERICIA_INICIATIVA]?.value) || 0;
  const total = dado + pericia + bonusDeAprimoramentos(actor, aprimoramentos);

  await combate.setInitiative(combatente.id, total);
  return total;
}
