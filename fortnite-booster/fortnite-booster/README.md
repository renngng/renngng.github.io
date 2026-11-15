# FORTNITE BOOSTER

Otimizador de desempenho para Windows 10/11 com foco no Fortnite. Interface em Electron; toda
ação real roda no processo principal (Node.js + PowerShell/CMD) e é exposta à interface somente por
IPC seguro, com lista fechada de ações.

> **Aviso:** este projeto foi escrito sem acesso a um Windows para executá-lo. A sintaxe de todos
> os arquivos JavaScript foi verificada, mas **o app ainda não foi testado em um PC real**. Rode,
> teste cada recurso (comece pelo Terminal) e ajuste o que o seu hardware/versão do Windows
> exigir. Veja "Limites conhecidos" no final.

## Requisitos
- Windows 10 ou 11
- Node.js 18+ (https://nodejs.org)

## Instalar e executar
```powershell
cd fortnite-booster
npm install
npm start
```
Para recursos que exigem administrador (ponto de restauração, DISM, SFC, PresentMon, limpeza de
`C:\Windows\Temp`), use o botão **Reiniciar como administrador** no canto inferior esquerdo.

## Gerar o executável (.exe)
```powershell
npm install
npm run dist
```
Saem em `dist/`: um instalador (NSIS) e uma versão portátil. A versão do Electron em
`package.json` é `^33`; se quiser a mais recente, rode `npm install electron@latest --save-dev`.
Sem ícone próprio, o electron-builder usa o padrão (coloque `build/icon.ico` para personalizar).

## O que cada recurso faz de verdade
| Recurso | Como funciona |
|---|---|
| Métricas (CPU, RAM) | `os.cpus()` / `os.freemem()` do Node, a cada 2 s |
| Disco, nº de processos | `Get-CimInstance Win32_LogicalDisk`, `Get-Process` |
| Uso de GPU | `nvidia-smi` (se existir) ou contador `GPU Engine` do Windows; senão "indisponível" |
| Temp. GPU | `nvidia-smi` (somente NVIDIA); senão "indisponível" |
| Temp. CPU | Zona térmica ACPI (`MSAcpi_ThermalZoneTemperature`). Muitos PCs não expõem; então "indisponível" |
| FPS | PresentMon (veja abaixo); sem ele, "indisponível" |
| Limpar temporários | Apaga arquivos com mais de 24 h em `%TEMP%` (e `C:\Windows\Temp` com admin). Pede confirmação. Irreversível |
| Cache de shaders | `D3DSCache`, `NVIDIA\DXCache`, `NVIDIA\GLCache`, `AMD\DxCache` e `FortniteGame\Saved\PipelineCaches` (as que existirem). Só com o jogo fechado; opcional |
| Plano de energia | `powercfg /setactive` para Alto Desempenho; guarda o plano anterior e restaura |
| Inicialização | Lista chaves `Run` (HKCU e HKLM). Desativar/reativar itens do **usuário** pelo mesmo mecanismo do Gerenciador de Tarefas (`StartupApproved`); reversível |
| Serviços | **Somente lista** serviços opcionais em execução. Nunca desativa nada |
| Integridade | `DISM /CheckHealth` e `sfc /verifyonly` (somente verificam; exigem admin) |
| Fechar apps | Apenas apps com janela, fora de uma lista de proteção (sistema, Defender, Epic, o próprio app). Fechamento educado (`CloseMainWindow`), sem forçar |
| Modo Fortnite | Detecta instalação (manifestos do Epic Launcher) e o processo `FortniteClient-Win64-Shipping`; Alto Desempenho; Modo de Jogo ligado; Game DVR e captura em segundo plano desligados; prioridade **Alta** (nunca Tempo real). Tudo registrado e revertido ao desativar |
| Ponto de restauração | `Checkpoint-Computer` (admin; Proteção do Sistema ativada; o Windows limita a 1 a cada 24 h) |

O app **não** mexe em Windows Defender, firewall, Windows Update nem serviços de segurança.

## Segurança da arquitetura
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP restrita, navegação bloqueada.
- A interface só chama `window.fb.invoke(ação, params)`. O main aceita apenas ações da tabela `HANDLERS`.
- Scripts PowerShell são constantes do código; valores variáveis (nome, PID, GUID) entram por
  variáveis de ambiente e são validados antes (PIDs contra a lista de apps elegíveis, GUIDs por regex,
  chaves de registro por lista de permissão).
- O **Terminal** só aceita comandos de uma lista fechada (`help` mostra todos). Não é um shell livre.
- Operações destrutivas ou administrativas pedem confirmação em diálogo nativo.
- Alterações reversíveis ficam em `%APPDATA%\fortnite-booster\estado.json`; o histórico em `historico.jsonl`.

## FPS com PresentMon
1. Baixe o PresentMon (projeto open source da Intel) na página de releases oficial.
2. Copie o `PresentMon*.exe` para a pasta `tools/` do projeto (ou `%APPDATA%\fortnite-booster\tools\`).
3. Abra o app como administrador, abra o Fortnite e clique em **Iniciar captura** na aba Desempenho.

O app tenta a sintaxe de linha de comando das versões 2.x e, se falhar, a das 1.x. O FPS exibido é
calculado a partir dos tempos de quadro reais; o "1% mínimo" usa os últimos 10 s.

## Estrutura
```
main.js              janela, IPC seguro, loop de métricas
preload.js           ponte (contextBridge) com lista de canais
src/core/actions.js  todas as ações autorizadas, validação, modo Fortnite, restauração
src/core/powershell.js  execução de PowerShell/EXE
src/core/system.js   métricas e informações do sistema
src/core/fps.js      captura de FPS via PresentMon
src/core/store.js    registro persistente de alterações (undo)
src/core/logger.js   terminal/histórico
renderer/            interface (HTML, CSS, JS)
tools/               coloque o PresentMon aqui
```

## Limites conhecidos
- Não testado em Windows real (ver aviso no topo).
- Temperatura de CPU via ACPI é uma zona térmica geral, não o sensor do núcleo; para leituras
  precisas seria preciso um driver de sensores (ex.: LibreHardwareMonitor), que este projeto não inclui.
- Caminhos de cache de shaders do Fortnite variam entre versões; o app só limpa o que existe.
- Saída de DISM/SFC é localizada e acentos podem aparecer trocados no Terminal; o resultado
  (sucesso/falha) vem do código de saída.
- Instalador sem assinatura digital: o SmartScreen pode avisar.
