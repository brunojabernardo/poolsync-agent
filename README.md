# PoolSync Agent

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

O `camera-boxes.json` vai embutido no `.exe`. Publica o `dist/PoolSyncAgent.exe`
como asset de um **GitHub Release** com esse nome exato — o site aponta para
`releases/latest/download/PoolSyncAgent.exe`.

### Fluxo do cliente (sem Node/terminal)

1. Descarrega o `PoolSyncAgent.exe` e o `poolsync.config.json` (do site).
2. Põe os dois na mesma pasta.
3. Duplo-clique no `.exe`. Liga ao OBS local e ao servidor.
