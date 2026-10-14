/**
 * Negócios: a ponte com o módulo `t20-negocios`.
 *
 * O negócio não mora na ficha: é um Actor próprio (`t20-negocios.negocio`),
 * ligado ao personagem por `system.proprietario`. Tudo que é regra — quanto
 * rende, o que vai para o registro, o card no chat — continua sendo do módulo
 * dele, chamado pela API pública (`game.modules.get(...).api.Operacoes`). Aqui
 * só se monta o que a tela precisa e se traduz o d20 da mesa num resultado de
 * teste: as operações do módulo recebem o teste já pronto, então o dado
 * físico entra sem que nada role no Foundry.
 *
 * Criar e expandir ficam de fora de propósito: é o mestre quem faz, pela
 * ficha do próprio módulo. O app rende e movimenta o cofre.
 */

const MODULO_NEGOCIOS = "t20-negocios";
const TIPO_NEGOCIO = `${MODULO_NEGOCIOS}.negocio`;
const PERICIA_NOBREZA = "nobr";
/**
 * Onde o módulo de negócios paga e cobra: `tp` é o tibar comum (T$), o
 * `to` é o de ouro. Ver `CAMPO_TIBARES` no t20-adapter dele.
 */
const CAMPO_TIBARES = "tp";

/** Quantas entradas do registro vão para a tela — o resto fica no Foundry. */
const LIMITE_REGISTRO = 10;

/** A API do módulo, ou null quando ele não está ativo neste mundo. */
function api() {
  const modulo = game.modules.get(MODULO_NEGOCIOS);
  return modulo?.active ? (modulo.api ?? null) : null;
}

/**
 * O módulo está ativo e já publicou a API? As duas condições importam: a API
 * só nasce no `ready` dele, e um mundo pode ter o módulo instalado mas
 * desligado.
 */
export function disponivel() {
  return !!api()?.Operacoes;
}

export function ehNegocio(actor) {
  return actor?.type === TIPO_NEGOCIO;
}

/**
 * As perícias com que se administra um negócio: Nobreza e cada Ofício,
 * inclusive os personalizados. Mesmo critério do `periciasDeAdministracao` do
 * módulo, que não vem na API — e é esta lista que valida a perícia que chega
 * do front, então o bônus usado no rendimento nunca é um número do celular.
 */
export function periciasDeRender(actor) {
  const pericias = actor?.system?.pericias ?? {};
  const rotulo = (chave) => game.i18n.localize(CONFIG.T20?.pericias?.[chave]?.label ?? chave);
  const oficios = [...(CONFIG.T20?.oficios ?? [])];
  const prefixo = game.i18n.localize("T20.SkillOfic");

  const lista = [];
  if (pericias[PERICIA_NOBREZA]) {
    lista.push({ chave: PERICIA_NOBREZA, rotulo: rotulo(PERICIA_NOBREZA), bonus: Number(pericias[PERICIA_NOBREZA].value) || 0 });
  }
  for (const chave of oficios) {
    if (!pericias[chave]) continue;
    lista.push({ chave, rotulo: `${prefixo}: ${rotulo(chave)}`, bonus: Number(pericias[chave].value) || 0 });
  }
  for (const [chave, pericia] of Object.entries(pericias)) {
    if (!pericia?.custom || lista.some((p) => p.chave === chave)) continue;
    const ehOficio = CONFIG.T20?.oficios?.has?.(chave) || (pericia.atributo === "int" && pericia.st === true);
    if (!ehOficio) continue;
    lista.push({ chave, rotulo: `${prefixo}: ${pericia.label || chave}`, bonus: Number(pericia.value) || 0 });
  }
  return lista;
}

/** Os negócios deste personagem que o usuário enxerga. */
function negociosDoAtor(actor, user) {
  return game.actors
    .filter((a) => ehNegocio(a) && a.system.proprietario === actor.id && a.testUserPermission(user, "OBSERVER"))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

function mapearNegocio(negocio, user) {
  const { ATIVOS, Regras } = api();
  const sistema = negocio.system;
  const emporio = sistema.temEmporio;

  const ativos = sistema.ativosEfetivos.map(({ id, definicao, copiado, escolha }) => ({
    id,
    nome: game.i18n.localize(definicao.nome),
    resumo: definicao.resumo ? game.i18n.localize(definicao.resumo) : "",
    escolha: escolha || "",
    copiado: !!copiado
  }));

  // Mais recente primeiro: é o que o jogador quer ver depois de render.
  const registro = sistema.registro
    .slice(-LIMITE_REGISTRO)
    .reverse()
    .map((entrada) => ({
      tipo: entrada.tipo,
      texto: entrada.texto ?? "",
      valor: entrada.valor ?? null,
      timestamp: entrada.timestamp ?? 0
    }));

  return {
    id: negocio.id,
    nome: negocio.name,
    img: negocio.img,
    ramo: sistema.ramo ?? "",
    local: sistema.local ?? "",
    nivel: sistema.nivel,
    nivelMaximo: sistema.nivelMaximo,
    porte: game.i18n.localize(sistema.porte),
    cofre: sistema.cofre,
    rendimentoBase: sistema.rendimentoBase,
    // `total × fator × nível` — o front usa para mostrar quanto o teste rende
    // antes de o jogador confirmar.
    fatorDedicado: Regras.fatorDedicado({ emporio }),
    emporio,
    ativos,
    registro,
    podeRender: negocio.testUserPermission(user, "OWNER")
  };
}

/**
 * O estado da tela de negócios para quem está olhando `actor`. Sem módulo, a
 * resposta é "indisponível" — e não um erro: é assim que a tela sabe explicar
 * que falta o módulo, em vez de mostrar uma lista vazia como se fosse falta
 * de negócio.
 */
export function listarNegocios(actor, user) {
  if (!disponivel() || !actor) {
    return { disponivel: disponivel(), negocios: [], pericias: [], tibaresNaMao: null };
  }
  return {
    disponivel: true,
    negocios: negociosDoAtor(actor, user).map((negocio) => mapearNegocio(negocio, user)),
    pericias: periciasDeRender(actor),
    tibaresNaMao: tibaresDe(actor)
  };
}

/** Os T$ do personagem — o limite do depósito. Null quando a ficha não tem o campo. */
function tibaresDe(actor) {
  const valor = actor?.system?.dinheiro?.[CAMPO_TIBARES];
  return Number.isFinite(valor) ? valor : null;
}

/**
 * O negócio que o front pediu, desde que seja deste personagem e quem pede o
 * administre — a mesma regra que o módulo aplica na ficha dele. O id vem do
 * celular, então é aqui que ele deixa de ser confiado.
 */
function negocioAdministrado(actor, user, negocioId) {
  const negocio = game.actors.get(negocioId);
  if (!ehNegocio(negocio) || negocio.system.proprietario !== actor.id) {
    throw new Error("Este negócio não é do personagem aberto.");
  }
  if (!negocio.testUserPermission(user, "OWNER")) {
    throw new Error(`Você não administra ${negocio.name}.`);
  }
  return negocio;
}

function exigirApi() {
  const modulo = api();
  if (!modulo?.Operacoes) throw new Error("O módulo Negócios não está ativo neste mundo.");
  return modulo;
}

/**
 * Apura o rendimento de um negócio. Sem `pericia`, é o rendimento básico;
 * com ela, o mês dedicado: o total do teste (d20 da mesa + bônus da perícia
 * na ficha) multiplica o nível. O dinheiro vai para o cofre do negócio —
 * sacar para a ficha é outra operação, do próprio módulo.
 */
export async function renderNegocio(actor, user, { negocioId, pericia = null, d20 = null } = {}) {
  const modulo = exigirApi();
  const negocio = negocioAdministrado(actor, user, negocioId);

  if (!pericia) {
    return modulo.Operacoes.apurarRendimento(negocio);
  }

  const escolhida = periciasDeRender(actor).find((p) => p.chave === pericia);
  if (!escolhida) throw new Error("Essa perícia não serve para administrar um negócio.");

  const dado = Math.floor(Number(d20));
  if (!Number.isFinite(dado) || dado < 1 || dado > 20) {
    throw new Error("O resultado do d20 precisa ser um número de 1 a 20.");
  }

  // `roll: null` — o dado rolou na mesa, não há rolagem para anexar. O card
  // do módulo já mostra o resultado do teste numa linha própria.
  return modulo.Operacoes.apurarRendimento(negocio, {
    resultado: { total: dado + escolhida.bonus, roll: null }
  });
}

/**
 * Saca do cofre para a ficha, ou deposita da ficha no cofre. Quem move o
 * dinheiro e lança no histórico é o módulo de negócios (`sacar`/`guardar`);
 * aqui só se recusa o que ele cortaria em silêncio — ele limita a quantia ao
 * que existe sem avisar, e o jogador veria um valor diferente do que digitou.
 */
export async function movimentarCofre(actor, user, { negocioId, operacao, quantia } = {}) {
  const modulo = exigirApi();
  const negocio = negocioAdministrado(actor, user, negocioId);

  const valor = Math.floor(Number(quantia));
  if (!Number.isFinite(valor) || valor <= 0) throw new Error("Digite uma quantia maior que zero.");

  if (operacao === "sacar") {
    if (valor > negocio.system.cofre) {
      throw new Error(`O cofre de ${negocio.name} tem só T$ ${negocio.system.cofre}.`);
    }
    return modulo.Operacoes.sacar(negocio, valor);
  }

  if (operacao === "depositar") {
    const naMao = tibaresDe(actor);
    if (naMao === null) throw new Error(`Não consegui ler os T$ de ${actor.name}.`);
    if (valor > naMao) throw new Error(`${actor.name} tem só T$ ${naMao}.`);
    return modulo.Operacoes.guardar(negocio, valor);
  }

  throw new Error("Operação de cofre desconhecida.");
}
