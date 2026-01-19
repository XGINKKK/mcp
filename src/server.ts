#!/usr/bin/env node
/**
 * Outlet das Cores MCP Server - HTTP Transport
 * 
 * Exposes CRM tools via HTTP for n8n integration.
 * Endpoint: POST /mcp
 */

import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Initialize Supabase
const supabase = createClient(
    process.env.SUPABASE_URL || "https://nfbbrgtvkvipdkvqlyrz.supabase.co",
    process.env.SUPABASE_SERVICE_KEY || ""
);

// ================== TOOL HANDLERS ==================

async function getLeads(params: { stage_slug?: string; vendedor_id?: string; limit?: number }) {
    let query = supabase
        .from("leads")
        .select(`
      *,
      stage:pipeline_stages(name, slug, color),
      vendedor:profiles(full_name, role)
    `)
        .order("created_at", { ascending: false })
        .limit(params.limit || 50);

    if (params.stage_slug) {
        const { data: stage } = await supabase
            .from("pipeline_stages")
            .select("id")
            .eq("slug", params.stage_slug)
            .single();

        if (stage) query = query.eq("stage_id", stage.id);
    }

    if (params.vendedor_id) {
        query = query.eq("vendedor_id", params.vendedor_id);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data;
}

async function updateLeadStage(params: { lead_id: string; new_stage_slug: string }) {
    const { data: stage, error: stageError } = await supabase
        .from("pipeline_stages")
        .select("id, name")
        .eq("slug", params.new_stage_slug)
        .single();

    if (stageError || !stage) throw new Error(`Stage not found: ${params.new_stage_slug}`);

    const { data, error } = await supabase
        .from("leads")
        .update({ stage_id: stage.id })
        .eq("id", params.lead_id)
        .select(`*, stage:pipeline_stages(name, slug)`)
        .single();

    if (error) throw new Error(error.message);
    return { success: true, message: `Lead moved to ${stage.name}`, lead: data };
}

async function updateLeadCustomFields(params: { lead_id: string; custom_fields: Record<string, unknown> }) {
    const { data: current } = await supabase
        .from("leads")
        .select("custom_fields")
        .eq("id", params.lead_id)
        .single();

    const merged = { ...(current?.custom_fields as object || {}), ...params.custom_fields };

    const { data, error } = await supabase
        .from("leads")
        .update({ custom_fields: merged })
        .eq("id", params.lead_id)
        .select()
        .single();

    if (error) throw new Error(error.message);
    return { success: true, lead: data };
}

async function createLead(params: {
    name: string;
    phone?: string;
    email?: string;
    stage_slug?: string;
    vendedor_id: string;
    custom_fields?: Record<string, unknown>;
    notes?: string;
}) {
    const { data: stage } = await supabase
        .from("pipeline_stages")
        .select("id")
        .eq("slug", params.stage_slug || "lead")
        .single();

    if (!stage) throw new Error(`Stage not found`);

    const { count } = await supabase
        .from("leads")
        .select("*", { count: "exact", head: true })
        .eq("stage_id", stage.id);

    const { data, error } = await supabase
        .from("leads")
        .insert({
            name: params.name,
            phone: params.phone,
            email: params.email,
            stage_id: stage.id,
            vendedor_id: params.vendedor_id,
            custom_fields: params.custom_fields || {},
            notes: params.notes,
            position: count || 0,
        })
        .select()
        .single();

    if (error) throw new Error(error.message);
    return { success: true, lead: data };
}

async function searchPriceCatalog(params: { query: string; category?: string; limit?: number }) {
    let query = supabase
        .from("price_catalog")
        .select("*")
        .eq("active", true)
        .limit(params.limit || 10);

    if (params.query) {
        query = query.or(`product_name.ilike.%${params.query}%,description.ilike.%${params.query}%`);
    }
    if (params.category) query = query.eq("category", params.category);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data;
}

async function getLeadHistory(params: { lead_id: string }) {
    const { data, error } = await supabase
        .from("lead_history")
        .select(`*, changed_by:profiles(full_name)`)
        .eq("lead_id", params.lead_id)
        .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);
    return data;
}

async function getPipelineStats() {
    const { data } = await supabase.from("leads").select(`stage_id, custom_fields, stage:pipeline_stages(name, slug)`);

    const stats: Record<string, { count: number; total_value: number; stage_name: string }> = {};
    for (const lead of data || []) {
        const slug = (lead.stage as any)?.slug || "unknown";
        if (!stats[slug]) stats[slug] = { count: 0, total_value: 0, stage_name: (lead.stage as any)?.name };
        stats[slug].count++;
        const value = (lead.custom_fields as any)?.valor_estimado;
        if (value) stats[slug].total_value += Number(value);
    }
    return stats;
}

// ================== MCP HTTP ENDPOINT ==================

// Tool definitions for n8n
const TOOLS = {
    get_leads: { handler: getLeads, description: "Get leads from pipeline" },
    update_lead_stage: { handler: updateLeadStage, description: "Move lead to stage" },
    update_lead_custom_fields: { handler: updateLeadCustomFields, description: "Update custom fields" },
    create_lead: { handler: createLead, description: "Create new lead" },
    search_price_catalog: { handler: searchPriceCatalog, description: "Search prices" },
    get_lead_history: { handler: getLeadHistory, description: "Get lead history" },
    get_pipeline_stats: { handler: getPipelineStats, description: "Get pipeline stats" },
};

// MCP HTTP Streamable endpoint
app.post("/mcp", async (req, res) => {
    try {
        const { method, params } = req.body;

        // Handle MCP protocol methods
        if (method === "tools/list") {
            return res.json({
                jsonrpc: "2.0",
                result: {
                    tools: Object.entries(TOOLS).map(([name, { description }]) => ({
                        name,
                        description,
                    })),
                },
            });
        }

        if (method === "tools/call") {
            const { name, arguments: args } = params;
            const tool = TOOLS[name as keyof typeof TOOLS];

            if (!tool) {
                return res.status(400).json({ error: `Tool not found: ${name}` });
            }

            const result = await tool.handler(args || {});
            return res.json({
                jsonrpc: "2.0",
                result: {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                },
            });
        }

        // Direct tool call (simplified for n8n)
        if (req.body.tool) {
            const { tool, arguments: args } = req.body;
            const toolDef = TOOLS[tool as keyof typeof TOOLS];

            if (!toolDef) {
                return res.status(400).json({ error: `Tool not found: ${tool}` });
            }

            const result = await toolDef.handler(args || {});
            return res.json({ success: true, result });
        }

        res.status(400).json({ error: "Invalid request" });
    } catch (error) {
        console.error("MCP Error:", error);
        res.status(500).json({
            error: error instanceof Error ? error.message : "Internal error"
        });
    }
});

// Health check - no Supabase call
app.get("/health", (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify({ status: "ok", server: "outlet-mcp-server" }));
});

// List tools endpoint (for easier testing)
app.get("/tools", (_req, res) => {
    res.json({
        tools: Object.entries(TOOLS).map(([name, { description }]) => ({
            name,
            description,
        })),
    });
});

// Start server - listen on all interfaces for Docker access
app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`🎨 Outlet MCP Server running on http://0.0.0.0:${PORT}`);
    console.log(`   Endpoint: POST http://localhost:${PORT}/mcp`);
    console.log(`   Docker:   POST http://host.docker.internal:${PORT}/mcp`);
    console.log(`   Health:   GET http://localhost:${PORT}/health`);
    console.log(`   Tools:    GET http://localhost:${PORT}/tools`);
});
