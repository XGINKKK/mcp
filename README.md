# Outlet das Cores - MCP Server

Servidor MCP para integração do CRM com AI Agents (n8n, Claude, etc).

## Tools Disponíveis

| Tool | Descrição |
|------|-----------|
| `get_leads` | Buscar leads do pipeline (com filtros) |
| `update_lead_stage` | Mover lead para outra etapa |
| `update_lead_custom_fields` | Atualizar campos customizados |
| `create_lead` | Criar novo lead |
| `search_price_catalog` | Buscar no catálogo de preços |
| `get_lead_history` | Ver histórico de um lead |
| `get_pipeline_stats` | Estatísticas do funil |

## Instalação

```bash
npm install
```

## Configuração

Crie um arquivo `.env` com:

```env
SUPABASE_URL=https://nfbbrgtvkvipdkvqlyrz.supabase.co
SUPABASE_SERVICE_KEY=sua-service-role-key
```

> ⚠️ Use a **Service Role Key** do Supabase (não a anon key)

## Uso

### Desenvolvimento
```bash
npm run dev
```

### Produção
```bash
npm run build
npm start
```

## Configuração Claude Desktop

Adicione ao `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "outlet-crm": {
      "command": "node",
      "args": ["D:/outletdascores/outlet-mcp-server/dist/index.js"],
      "env": {
        "SUPABASE_URL": "https://nfbbrgtvkvipdkvqlyrz.supabase.co",
        "SUPABASE_SERVICE_KEY": "sua-chave-aqui"
      }
    }
  }
}
```

## Exemplos de Uso

### Buscar leads na etapa "Negociação"
```json
{
  "tool": "get_leads",
  "arguments": {
    "stage_slug": "negociacao"
  }
}
```

### Mover lead para "Fechado"
```json
{
  "tool": "update_lead_stage",
  "arguments": {
    "lead_id": "uuid-do-lead",
    "new_stage_slug": "fechado"
  }
}
```

### Buscar preços de tinta acrílica
```json
{
  "tool": "search_price_catalog",
  "arguments": {
    "query": "acrílica"
  }
}
```
