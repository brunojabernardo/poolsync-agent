# PoolSync Agent

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)

Processo local que corre na máquina do operador e controla o **OBS** em nome da
app **PoolSync**. Liga-se ao OBS por WebSocket (`ws://localhost:4455`) e — quando
configurado — liga-se ao servidor PoolSync por `wss://`, funcionando como ponte:

```
Admin (browser) ──wss──▶ PoolSync (servidor) ◀──wss── PoolSync Agent ──ws──▶ OBS
```

Porquê um agente e não o browser a falar direto com o OBS? Porque a app é servida
em HTTPS e os browsers bloqueiam ligações `ws://` inseguras a partir de páginas
HTTPS (mixed content). O agente, sendo um processo Node local, não tem essa
limitação.

## Não confies neste ficheiro — confirma-o

O `.exe` que se descarrega **não é feito à mão por ninguém**: é construído pelo
GitHub a partir do código que está aqui, pelo workflow
[`publicar.yml`](.github/workflows/publicar.yml). De cada versão sai também o
`PoolSyncAgent.exe.sha256`, para poderes confirmar que o ficheiro que tens é o
mesmo que saiu daqui:

```powershell
Get-FileHash .\PoolSyncAgent.exe -Algorithm SHA256
```

E há uma declaração de proveniência assinada pelo GitHub, que amarra o binário
ao commit e à corrida que o produziram:

```bash
gh attestation verify PoolSyncAgent.exe -R brunojabernardo/poolsync-agent
```

**O aviso do Windows.** Enquanto a aplicação não tiver assinatura de código, o
SmartScreen mostra «*aplicação não reconhecida*»: **Mais informações → Executar
mesmo assim**. O aviso é sobre a falta de assinatura, não sobre o conteúdo — e
é por isso que o código está aqui à vista e o ficheiro é conferível.

**O que o agente precisa e o que não precisa.** Fala com o OBS na tua máquina
(`ws://localhost:4455`) e com o servidor PoolSync com uma **chave do teu
clube**, que vem no `poolsync.config.json` e nunca está dentro do executável.
Não abre nada à rede: a única porta que abre é a da pré-visualização de vídeo,
presa a `127.0.0.1` e com verificação de origem.

## Pré-requisitos no OBS

1. OBS 28 ou superior (traz o WebSocket v5 embutido).
2. **Tools → WebSocket Server Settings** → *Enable WebSocket server*.
3. Anota a porta (4455 por defeito) e a password (ou desliga a autenticação).

## Instalação

```bash
cd agent
npm install
cp .env.example .env   # e preenche os valores
```

## Testar já o controlo do OBS (sem servidor)

Com o `.env` a apontar para o teu OBS, estas verificam que tudo funciona:

```bash
node index.js status              # imprime o estado completo do OBS
node index.js scenes              # lista as cenas (a atual marcada com ▶)
node index.js scene "LIVE - Table 1"   # muda a cena de programa
```

## Correr o agente

```bash
npm start        # ou: node index.js
```

- Sem `SERVER_URL`/`DEVICE_KEY` → **modo local** (só OBS, útil para testes).
- Com ambos preenchidos → liga-se ao servidor e aparece no painel do admin.

O agente reconecta automaticamente ao OBS e ao servidor se a ligação cair.
`Ctrl+C` encerra em limpo. Ao ligar ao OBS, fixa automaticamente as câmaras nas
caixas certas (layout imune à resolução).

## Configuração via ficheiro (para o `.exe`)

Além do `.env`, o agente lê um `poolsync.config.json` **na mesma pasta do
executável**, com prioridade sobre o `.env`. É este o ficheiro que o site gera
pré-preenchido para o cliente:

```json
{
  "SERVER_URL": "https://<a-tua-app>.up.railway.app",
  "DEVICE_KEY": "<a-chave-do-cliente>",
  "USER_HANDLE": "owner"
}
```

## Build do executável (distribuição)

Gera um `.exe` Windows autónomo (sem Node instalado no cliente):

```bash
npm install          # inclui a devDependency @yao-pkg/pkg
npm run build        # → dist/PoolSyncAgent.exe (~60 MB)
```

Isto serve para experimentar. **A versão que se distribui não sai daqui**: sai
do GitHub Actions, ao empurrar uma etiqueta `v*` (ou pelo botão *Run workflow*).
O workflow empacota, soma o SHA-256, assina a
proveniência e anexa tudo à release — o site aponta para
`releases/latest/download/PoolSyncAgent.exe`.

### Fluxo do cliente (sem Node/terminal)

1. Descarrega o `PoolSyncAgent.exe` e o `poolsync.config.json` (do site).
2. Põe os dois na mesma pasta.
3. Duplo-clique no `.exe`. Liga ao OBS local e ao servidor.

## Licença

MIT — ver [LICENSE](LICENSE).
