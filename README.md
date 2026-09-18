# Arton de Bolso — módulo do Foundry VTT

Este módulo transforma o Foundry num **relay**: ele lê a ficha de Tormenta20 de
cada jogador, aplica as mudanças que chegam e retransmite tudo em tempo real
para o **Arton de Bolso**, uma ficha de celular que roda fora do Foundry.

Projeto pessoal de **Arthur Santos**.

> ### Sozinho, ele não faz nada visível
>
> O módulo não tem interface dentro do Foundry — não acrescenta botão, janela
> nem aba. Ele é metade de um par: a outra metade é o **front-end**
> (`arton-de-bolso-frontend`), um servidor Node que hospeda as telas que os
> jogadores abrem no navegador do celular.
>
> Instale os dois. Sem o módulo, o front não tem com o que conversar; sem o
> front, o módulo fica ativo e em silêncio.

---

## Por que esse par existe

A campanha era presencial, e uma aventura precisou ser narrada on-line. As
fichas foram para o Foundry, e os jogadores gostaram: números que se atualizam
sozinhos, nada de recalcular bônus a cada nível.

Voltar à mesa presencial com isso é que não funcionava. Notebook para todo
mundo era inviável, e a interface do Foundry no celular é feita para um mestre
com mouse e tela grande — não para um jogador conferindo quantos PM sobraram.

Daí a divisão de trabalho: o Foundry continua sendo a fonte da verdade e o
lugar onde o mestre administra o mundo; o celular ganha uma tela feita para o
polegar. Este módulo é a ponte entre os dois.

---

## Princípio central: nunca rola dados

Os dados são sempre rolados **fisicamente, na mesa**. O módulo nunca chama
`actor.rollPericia`, `actor.rollAtributo` ou `item.roll()`, e nunca escreve no
chat por conta própria. Onde um teste precisaria ser rolado, o front mostra a
**fórmula decomposta**, explicando de onde vem cada parte, para o jogador rolar
o dado físico e somar de cabeça.

---

## Como funciona

Um módulo do Foundry só executa dentro de um client já carregado — não existe
"servidor" nosso ouvindo porta nenhuma. O que existe é o canal de socket
próprio do Foundry (`"socket": true` no `module.json` → evento
`module.arton-de-bolso`): qualquer socket autenticado — inclusive uma conexão
que não seja um client Foundry completo, como o front — pode emitir e receber
nesse canal, desde que tenha feito o mesmo handshake de sessão que um client
real faz (`POST /join` com usuário e senha, depois conectar o socket.io
passando a sessão).

**O relay roda no client do mestre.** É o Foundry dele que precisa estar aberto
durante o jogo — se fechar, os celulares param de receber.

### Os arquivos

- **`scripts/relay.mjs`** só age dentro do client do **mestre**
  (`game.user.isGM`). Escuta os pedidos do front (`obterFicha`,
  `selecionarPersonagem`, `ajustarPV`, `alternarEquipado`, `gastarUso`…),
  aplica usando os métodos do sistema (ver tabela adiante) e retransmite só
  para o usuário que tem direito de ver aquele Actor — nunca para os outros.

  Também escuta `Hooks` — `updateActor`, `createItem`/`updateItem`/`deleteItem`
  e os de Active Effect — para empurrar a ficha nova mesmo quando a mudança
  veio do mestre editando direto no Foundry. Os de Active Effect são o que faz
  ativar e desativar um poder chegar ao celular: efeito é documento próprio e
  não dispara os outros dois hooks.

- **`scripts/adaptador-tormenta20.mjs`** é o único arquivo que conhece os
  caminhos de `actor.system.*` e `item.system.*`. Eles foram confirmados lendo
  o código-fonte do sistema `tormenta20` instalado — não só inspecionando um
  personagem ao vivo —, incluindo a mesma lógica que a ficha do sistema usa
  para montar o tooltip de PV/PM/Defesa/Perícia.

- **`scripts/diarios.mjs`** e **`scripts/compendio.mjs`** cuidam das anotações
  dos jogadores e do compêndio. São os únicos que falam com
  `JournalEntry`/`Folder`.

- **`scripts/html-seguro.mjs`** reduz o HTML que entra e sai a uma allowlist de
  tags e atributos.

### Quem vê o quê

A permissão nativa de Ownership do Foundry define os dois grupos que o front
mostra:

| Permissão no Actor | Onde aparece | O que pode fazer |
|---|---|---|
| **Owner** | "Meus Personagens" | Ler e escrever (PV, PM, itens, dinheiro, descanso) |
| **Observer** (sem Owner) | "Companheiros" | Só ler — a ficha chega com `somenteLeitura: true` e toda escrita é recusada |

`somenteLeitura` é só uma dica de interface: quem autoriza de verdade é o
`testUserPermission(user, "OWNER")` que o relay refaz antes de **cada** escrita,
com o `userId` que o próprio servidor do Foundry carimba na mensagem.

---

## Ações — sempre via método do sistema

| Ação | Chamada |
|---|---|
| Dano em PV | `actor.applyDamage(quantidade, 1, false)` — já desconta do PV temporário primeiro |
| Cura de PV | `actor.applyDamage(-quantidade, 1, false)` |
| Gastar PM | `actor.spendMana(quantidade, 0, false)` |
| Recuperar PM | `actor.spendMana(quantidade, 0, true)` |
| Equipar/desequipar | `item.update({ "system.equipado": !equipadoAtual })` |
| Ajustar moeda | `actor.update({ "system.dinheiro.<tc\|tl\|to\|tp>": novoValor })` |
| Ativar poder / conjurar / usar item | `gastarUso` — desconta PM e unidades de item, e anuncia no chat |

Reaproveitar os métodos do sistema em vez de escrever direto em
`system.attributes.pv.value` evita duplicar a lógica de clamp e de pontos
temporários que o sistema já resolve corretamente.

**Moedas**: os nomes dos campos não seguem a sigla do metal (inconsistência do
próprio sistema `tormenta20`, confirmada lendo `schemaCurrency`) — `tc`=Cobre,
`tl`=Platina, `to`=Ouro, `tp`=Prata.

**`equipado`**: `boolean` em itens `equipamento`, `number` (0/1/2) em itens
`arma` — o adaptador lê sempre via `!!item.system.equipado` e grava um
`boolean` (o `NumberField` da arma converte automaticamente).

---

## Tags de poder (`system.rolltags`)

Duas tags que o mestre escreve no poder mudam como o app o mostra:

| Tag | O que faz |
|---|---|
| `lvl-06` | Nível em que o poder foi ganho — agrupa a lista ("Nível 6"). Sem ela, o poder entra em "Base" (raça, origem, divindade) |
| `ativo` | O poder ganha o botão **Ativar**: cobra o custo em PM/itens, liga na ficha os Active Effects do poder e publica o card do sistema no chat. Sem ela é passiva: só o texto |

Ativar é uma coisa só do lado do jogador, e três do lado do Foundry: o gasto
(com os aprimoramentos marcados na conta), os efeitos ligados na ficha — Fúria,
Frenesi e afins, com a duração convertida da duração do poder, renovando em vez
de empilhar — e o card nativo (`displayCard`) na mesa, com os botões de aplicar
o efeito em outros alvos. O card sai **sem rolar dado nenhum** e sem o botão de
gastar PM, porque o app já cobrou; o gasto vira o `flavor` da mensagem.

`ativo` é decisão do mestre de propósito. Uma heurística — "tem execução
declarada", "cobra PM" — erraria nos dois sentidos: no compêndio há passiva com
execução preenchida e poder de usar que não cobra nada.

---

## Perícias — fórmula decomposta, sem rolar

Cada perícia decompõe em: modificador do atributo, bônus de treino
(`system.attributes.treino`, só se `.treinado`; tabela +2/+4/+6 por nível
confirmada no código-fonte), `.outros` e `.condi`. Qualquer diferença entre essa
soma e o `.value` total (penalidade de armadura, modificador de tamanho, efeitos
ativos) entra como uma linha final "Outros efeitos" — nunca é descartada em
silêncio.

---

## Anotações dos jogadores

Uma pasta **"Anotações Jogadores"** com um `JournalEntry` por jogador, criada
sozinha quando o mestre abre o mundo (e, para quem entrar depois, na primeira
visita à tela). Cada anotação é uma página de texto do journal.

| Diário | Ownership | O que o jogador faz |
|---|---|---|
| O dele | `OWNER` (e `default: OBSERVER`) | Cria, edita, renomeia e apaga anotações |
| Dos colegas | `OBSERVER` | Só lê |

É a permissão nativa do Foundry, então o mestre vê tudo, pode reorganizar pela
interface dele e o conteúdo entra no backup do mundo. Como nas fichas, o relay
refaz o `testUserPermission` antes de escrever — e resolve a página **dentro**
do diário de quem pediu, de forma que o id de uma página alheia não encontra
documento nenhum.

A anotação é **texto formatado** (negrito, itálico, listas), e tudo que entra ou
sai passa por `scripts/html-seguro.mjs`. Sem essa poda, um jogador poderia
gravar `<script>` no próprio diário e executá-lo no navegador de quem lesse — o
do mestre inclusive, que é quem roda o relay. Imagem dentro do texto não passa.

Se o mestre já tiver criado à mão um journal com o nome do jogador dentro dessa
pasta, o módulo **adota** esse (marcando-o com a flag `donoId`) em vez de criar
um segundo.

---

## Compêndio — o material que o mestre libera

A pasta **"Conteúdos Para Jogadores"** (criada junto com a de anotações) e
quantas subpastas o mestre quiser dentro dela — retratos de NPC, regras
específicas da mesa, cartas e o que mais ele quiser deixar à mão do grupo. O
front navega essa árvore como ela é, e o **journal conta como mais um nível**:
quem abre e vê é a *página* — a carta, o retrato, o mapa. Um journal de uma
página só leva direto a ela.

**Liberar algo é dar Observador no journal** — não há passo de publicação no
app. O journal nasce invisível, aparece na tela de quem recebeu a permissão e
some de novo quando ela é tirada, com a tela do jogador acompanhando ao vivo.

Só páginas de **texto** (formatado, mesma peneira das anotações) e de **imagem**
(com legenda). Vídeo, PDF e os demais tipos ficam de fora, e um journal — ou uma
pasta — que não sobre nada visível nem entra na lista.

A pasta é procurada **ignorando acentos e caixa**: uma versão anterior do módulo
a criou como "Conteudos Para Jogadores", e achar as duas grafias evita o mundo
terminar com duas pastas quase iguais (a antiga é renomeada para a forma com
acento).

---

## Requisitos

| | |
|---|---|
| Foundry VTT | versão 14 |
| Sistema | `tormenta20` 1.6.0 ou mais novo |
| O par | o front-end `arton-de-bolso-frontend`, hospedado à parte |
| Durante o jogo | o Foundry do **mestre** aberto — é o client dele que roda o relay |

---

## Instalando

### Pelo Foundry

Instale pelo navegador de pacotes ou cole a URL do manifesto em
**Configurações → Gerenciar Módulos → Instalar Módulo**. Depois ative o módulo
no mundo, em **Configurações do Mundo → Gerenciar Módulos**.

### Durante o desenvolvimento

O Foundry carrega o módulo de `Data/modules/arton-de-bolso/`, não do seu clone
do repositório — **editar aqui não muda nada no jogo até copiar para lá**. O
que precisa ir são o `module.json` e a pasta `scripts/`.

Depois de copiar, **dê F5 no client do mestre**: é ele que executa o relay, e o
módulo só recarrega junto com a página. Esse F5 vale para toda alteração, e é o
passo mais fácil de esquecer.

Se você trabalha com o Foundry no Windows e o código no WSL, **não tente
resolver isso com symlink**: um link criado pelo WSL dentro de `/mnt/c` é um
reparse point que o Windows não resolve — ele apontaria para o ext4 do WSL,
invisível para o processo do Foundry. Copiar é o caminho que funciona nos dois
lados, e vale automatizar com um script seu.

O front-end tem instalação e deploy próprios; veja o README dele.

### Publicando uma versão

A tag é a fonte da verdade: empurrá-la dispara a Action
(`.github/workflows/release.yml`), que carimba a versão no `module.json`, monta
o zip, cria a release no GitHub e registra a versão no foundryvtt.com.

```bash
git tag v0.4.1 && git push origin v0.4.1
```

O registro no site depende do segredo `FOUNDRY_PACKAGE_TOKEN` (o "Package
Release Token" da página do pacote). Sem ele, a release do GitHub sai igual e o
registro fica para fazer à mão. Para ensaiar sem publicar, crie a variável de
repositório `FOUNDRY_DRY_RUN=true`.

---

## Sobre o desenvolvimento

Este projeto foi construído **com ajuda de IA**, e isso está dito aqui porque é
a verdade do processo. O que garante o resultado é o que vem depois: **toda
funcionalidade é revisada e testada em jogo por gente**. As decisões de regra
foram conferidas contra o livro e contra o código-fonte do sistema `tormenta20`,
não por dedução, e o que sobrevive é o que passou por uma sessão real.

Todo o código — classes, funções, variáveis, comentários — é escrito em
**português do Brasil**.

---

## Pendências conhecidas

1. **Múltiplos mestres conectados ao mesmo tempo**: cada um responderia às
   mensagens do front, podendo gerar respostas duplicadas (raro, não tratado).
2. **Deslocamento**: mostrado como valor único, sem decompor modificadores
   (raça, etc.) — o sistema não guarda esse breakdown de forma acessível.

---

## Sugestões e contribuições

**Toda conversa começa numa issue** — um problema que você encontrou, uma
ideia, uma dúvida sobre alguma decisão, ou qualquer outra coisa. Não existe
assunto pequeno demais para abrir uma.

**Se for um problema, anexe vídeo ou imagem.** Boa parte do que quebra aqui é
de tela e de toque, e uma gravação de dez segundos costuma dizer o que três
parágrafos não dizem. Junte o que ajudar a reproduzir: aparelho, navegador,
versão do Foundry e o que você estava fazendo na hora.

**Se quiser contribuir com código**, fique à vontade:

1. Abra uma issue descrevendo o que pretende alterar — assim ninguém mexe na
   mesma coisa em paralelo, e dá para alinhar o rumo antes de você gastar o
   tempo.
2. Trabalhe numa branch própria.
3. Abra o pull request para a `main`.

A gente revisa e **testa em jogo** — é o mesmo critério que vale para o resto
do projeto: nada entra por ter compilado. Aprovado, **seu nome passa a constar
entre os desenvolvedores do projeto** e a sua mudança sai na próxima release.

Uma coisa a saber antes de começar: o código deste projeto é escrito em
**português do Brasil** — nomes de classes, funções, variáveis e comentários.
