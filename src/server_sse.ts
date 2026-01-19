#!/usr/bin/env node
/**
 * Outlet das Cores MCP Server - SSE Transport
 * 
 * Exposes CRM tools via MCP SSE Transport for n8n native integration.
 * Endpoint: GET /sse  POST /messages
 */

import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import "dotenv/config";

// Initialize Supabase
const supabase = createClient(
    process.env.SUPABASE_URL || "https://nfbbrgtvkvipdkvqlyrz.supabase.co",
    process.env.SUPABASE_SERVICE_KEY || ""
);

// Create MCP server
const server = new Server(
    {
        name: "outlet-crm",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
            resources: {},
        },
    }
);

// ================== TOOL IMPLEMENTATIONS ==================

// Helper schemas
const GetLeadsSchema = z.object({
    stage_slug: z.string().optional().describe("Filter by stage slug"),
    vendedor_id: z.string().uuid().optional().describe("Filter by vendedor ID"),
    limit: z.number().optional().default(50).describe("Max results"),
});

const UpdateLeadStageSchema = z.object({
    lead_id: z.string().uuid().describe("ID of the lead"),
    new_stage_slug: z.string().describe("New stage slug"),
});

const UpdateLeadCustomFieldsSchema = z.object({
    lead_id: z.string().uuid().describe("ID of the lead"),
    custom_fields: z.record(z.unknown()).describe("Custom fields to update"),
});

const CreateLeadSchema = z.object({
    name: z.string().describe("Contact name"),
    phone: z.string().optional().describe("Phone"),
    email: z.string().email().optional().describe("Email"),
    stage_slug: z.string().optional().default("lead").describe("Initial stage"),
    vendedor_id: z.string().uuid().describe("Seller UUID"),
    custom_fields: z.record(z.unknown()).optional().describe("Custom fields"),
    notes: z.string().optional().describe("Notes"),
});

const SearchPriceCatalogSchema = z.object({
    query: z.string().describe("Search query"),
    category: z.string().optional().describe("Category filter"),
    limit: z.number().optional().default(10).describe("Max results"),
});

const GetLeadHistorySchema = z.object({
    lead_id: z.string().uuid().describe("Lead UUID"),
});

// Tool Logic
async function getLeads(params: z.infer<typeof GetLeadsSchema>) {
    let query = supabase
        .from("leads")
        .select(`*, stage:pipeline_stages(name, slug, color), vendedor:profiles(full_name, role)`)
        .order("created_at", { ascending: false })
        .limit(params.limit || 50);

    if (params.stage_slug) {
        const { data: stage } = await supabase.from("pipeline_stages").select("id").eq("slug", params.stage_slug).single();
        if (stage) query = query.eq("stage_id", stage.id);
    }
    if (params.vendedor_id) query = query.eq("vendedor_id", params.vendedor_id);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data;
}

async function updateLeadStage(params: z.infer<typeof UpdateLeadStageSchema>) {
    const { data: stage } = await supabase.from("pipeline_stages").select("id, name").eq("slug", params.new_stage_slug).single();
    if (!stage) throw new Error(`Stage not found: ${params.new_stage_slug}`);

    const { data, error } = await supabase.from("leads").update({ stage_id: stage.id }).eq("id", params.lead_id).select().single();
    if (error) throw new Error(error.message);
    return { success: true, message: `Lead moved to ${stage.name}`, lead: data };
}

async function updateLeadCustomFields(params: z.infer<typeof UpdateLeadCustomFieldsSchema>) {
    const { data: current } = await supabase.from("leads").select("custom_fields").eq("id", params.lead_id).single();
    const merged = { ...(current?.custom_fields as object || {}), ...params.custom_fields };
    const { data, error } = await supabase.from("leads").update({ custom_fields: merged }).eq("id", params.lead_id).select().single();
    if (error) throw new Error(error.message);
    return { success: true, lead: data };
}

async function createLead(params: z.infer<typeof CreateLeadSchema>) {
    const { data: stage } = await supabase.from("pipeline_stages").select("id").eq("slug", params.stage_slug || "lead").single();
    if (!stage) throw new Error(`Stage not found`);
    const { count } = await supabase.from("leads").select("*", { count: "exact" }).eq("stage_id", stage.id);
    const { data, error } = await supabase.from("leads").insert({
        name: params.name,
        phone: params.phone,
        email: params.email,
        stage_id: stage.id,
        vendedor_id: params.vendedor_id,
        custom_fields: params.custom_fields || {},
        notes: params.notes,
        position: count || 0,
    }).select().single();
    if (error) throw new Error(error.message);
    return { success: true, lead: data };
}

async function searchPriceCatalog(params: z.infer<typeof SearchPriceCatalogSchema>) {
    let query = supabase.from("price_catalog").select("*").eq("active", true).limit(params.limit || 10);
    if (params.query) query = query.or(`product_name.ilike.%${params.query}%,description.ilike.%${params.query}%`);
    if (params.category) query = query.eq("category", params.category);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data;
}

async function getLeadHistory(params: z.infer<typeof GetLeadHistorySchema>) {
    const { data, error } = await supabase.from("lead_history").select(`*, changed_by:profiles(full_name)`).eq("lead_id", params.lead_id).order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
}

async function getPipelineStats() {
    const { data } = await supabase.from("leads").select(`stage_id, custom_fields, stage:pipeline_stages(name, slug)`);
    const stats: Record<string, any> = {};
    for (const lead of data || []) {
        const slug = (lead.stage as any)?.slug || "unknown";
        if (!stats[slug]) stats[slug] = { count: 0, total_value: 0, stage_name: (lead.stage as any)?.name };
        stats[slug].count++;
        const value = (lead.custom_fields as any)?.valor_estimado;
        if (value) stats[slug].total_value += Number(value);
    }
    return stats;
}

// ================== MCP HANDLERS ==================

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "get_leads",
                description: "Get leads filterable by stage and vendedor",
                inputSchema: {
                    type: "object",
                    properties: {
                        stage_slug: { type: "string" },
                        vendedor_id: { type: "string" },
                        limit: { type: "number" }
                    }
                }
            },
            {
                name: "update_lead_stage",
                description: "Move lead to stage",
                inputSchema: {
                    type: "object",
                    properties: {
                        lead_id: { type: "string" },
                        new_stage_slug: { type: "string" }
                    },
                    required: ["lead_id", "new_stage_slug"]
                }
            },
            {
                name: "update_lead_custom_fields",
                description: "Update custom fields",
                inputSchema: {
                    type: "object",
                    properties: {
                        lead_id: { type: "string" },
                        custom_fields: { type: "object" }
                    },
                    required: ["lead_id", "custom_fields"]
                }
            },
            {
                name: "create_lead",
                description: "Create new lead",
                inputSchema: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        phone: { type: "string" },
                        vendedor_id: { type: "string" },
                        stage_slug: { type: "string" },
                        custom_fields: { type: "object" },
                        notes: { type: "string" }
                    },
                    required: ["name", "vendedor_id"]
                }
            },
            {
                name: "search_price_catalog",
                description: "Search prices",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string" },
                        limit: { type: "number" }
                    },
                    required: ["query"]
                }
            },
            {
                name: "get_lead_history",
                description: "Get history",
                inputSchema: {
                    type: "object",
                    properties: { lead_id: { type: "string" } },
                    required: ["lead_id"]
                }
            },
            {
                name: "get_pipeline_stats",
                description: "Get stats",
                inputSchema: { type: "object", properties: {} }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let result;
    try {
        switch (name) {
            case "get_leads": result = await getLeads(GetLeadsSchema.parse(args)); break;
            case "update_lead_stage": result = await updateLeadStage(UpdateLeadStageSchema.parse(args)); break;
            case "update_lead_custom_fields": result = await updateLeadCustomFields(UpdateLeadCustomFieldsSchema.parse(args)); break;
            case "create_lead": result = await createLead(CreateLeadSchema.parse(args)); break;
            case "search_price_catalog": result = await searchPriceCatalog(SearchPriceCatalogSchema.parse(args)); break;
            case "get_lead_history": result = await getLeadHistory(GetLeadHistorySchema.parse(args)); break;
            case "get_pipeline_stats": result = await getPipelineStats(); break;
            default: throw new Error(`Unknown tool: ${name}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
        return { content: [{ type: "text", text: String(error) }], isError: true };
    }
});

// ================== EXPRESS SERVER WITH SSE ==================

const app = express();
app.use(cors());

let transport: SSEServerTransport;

app.get("/sse", async (req, res) => {
    transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
});

app.post("/messages", async (req, res) => {
    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(400).send("No valid transport connection");
    }
});

app.get("/health", (req, res) => {
    res.json({ status: "ok", mode: "sse" });
});

const PORT = process.env.PORT || 3001;
app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`🎨 Outlet MCP Server (SSE) running on port ${PORT}`);
    console.log(`   SSE Endpoint: http://localhost:${PORT}/sse`);
    console.log(`   Messages:     http://localhost:${PORT}/messages`);
});
