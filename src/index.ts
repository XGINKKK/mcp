#!/usr/bin/env node
/**
 * Outlet das Cores MCP Server
 * 
 * Tools for managing CRM leads, pipeline stages, and price catalog.
 * Designed for integration with n8n AI agents.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// Initialize Supabase client with service role key for full access
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

// ================== TOOL SCHEMAS ==================

const GetLeadsSchema = z.object({
    stage_slug: z.string().optional().describe("Filter by stage slug (lead, orcamento, negociacao, fechado, curioso)"),
    vendedor_id: z.string().uuid().optional().describe("Filter by vendedor (seller) ID"),
    limit: z.number().optional().default(50).describe("Max results to return"),
});

const UpdateLeadStageSchema = z.object({
    lead_id: z.string().uuid().describe("ID of the lead to update"),
    new_stage_slug: z.string().describe("Slug of new stage (lead, orcamento, negociacao, fechado, curioso)"),
});

const UpdateLeadCustomFieldsSchema = z.object({
    lead_id: z.string().uuid().describe("ID of the lead to update"),
    custom_fields: z.record(z.unknown()).describe("Custom fields to update (key-value pairs)"),
});

const CreateLeadSchema = z.object({
    name: z.string().describe("Name of the lead/contact"),
    phone: z.string().optional().describe("Phone number"),
    email: z.string().email().optional().describe("Email address"),
    stage_slug: z.string().optional().default("lead").describe("Initial stage slug"),
    vendedor_id: z.string().uuid().describe("ID of the vendedor (seller) responsible"),
    custom_fields: z.record(z.unknown()).optional().describe("Custom fields for the lead"),
    notes: z.string().optional().describe("Notes about the lead"),
});

const SearchPriceCatalogSchema = z.object({
    query: z.string().describe("Search query for products (name, category, or description)"),
    category: z.string().optional().describe("Filter by category"),
    limit: z.number().optional().default(10).describe("Max results"),
});

const GetLeadHistorySchema = z.object({
    lead_id: z.string().uuid().describe("ID of the lead to get history for"),
});

// ================== TOOL HANDLERS ==================

async function getLeads(params: z.infer<typeof GetLeadsSchema>) {
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

        if (stage) {
            query = query.eq("stage_id", stage.id);
        }
    }

    if (params.vendedor_id) {
        query = query.eq("vendedor_id", params.vendedor_id);
    }

    const { data, error } = await query;

    if (error) throw new Error(`Failed to fetch leads: ${error.message}`);
    return data;
}

async function updateLeadStage(params: z.infer<typeof UpdateLeadStageSchema>) {
    // Get stage ID from slug
    const { data: stage, error: stageError } = await supabase
        .from("pipeline_stages")
        .select("id, name")
        .eq("slug", params.new_stage_slug)
        .single();

    if (stageError || !stage) {
        throw new Error(`Stage not found: ${params.new_stage_slug}`);
    }

    // Update lead
    const { data, error } = await supabase
        .from("leads")
        .update({ stage_id: stage.id })
        .eq("id", params.lead_id)
        .select(`*, stage:pipeline_stages(name, slug)`)
        .single();

    if (error) throw new Error(`Failed to update lead: ${error.message}`);

    return {
        success: true,
        message: `Lead moved to ${stage.name}`,
        lead: data,
    };
}

async function updateLeadCustomFields(params: z.infer<typeof UpdateLeadCustomFieldsSchema>) {
    // Get current custom fields
    const { data: current, error: fetchError } = await supabase
        .from("leads")
        .select("custom_fields")
        .eq("id", params.lead_id)
        .single();

    if (fetchError) throw new Error(`Lead not found: ${params.lead_id}`);

    // Merge custom fields
    const mergedFields = {
        ...(current.custom_fields as object || {}),
        ...params.custom_fields,
    };

    // Update
    const { data, error } = await supabase
        .from("leads")
        .update({ custom_fields: mergedFields })
        .eq("id", params.lead_id)
        .select()
        .single();

    if (error) throw new Error(`Failed to update custom fields: ${error.message}`);

    return {
        success: true,
        message: "Custom fields updated",
        lead: data,
    };
}

async function createLead(params: z.infer<typeof CreateLeadSchema>) {
    // Get stage ID
    const { data: stage } = await supabase
        .from("pipeline_stages")
        .select("id")
        .eq("slug", params.stage_slug || "lead")
        .single();

    if (!stage) throw new Error(`Stage not found: ${params.stage_slug}`);

    // Get position
    const { count } = await supabase
        .from("leads")
        .select("*", { count: "exact", head: true })
        .eq("stage_id", stage.id);

    // Create lead
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

    if (error) throw new Error(`Failed to create lead: ${error.message}`);

    return {
        success: true,
        message: `Lead "${params.name}" created successfully`,
        lead: data,
    };
}

async function searchPriceCatalog(params: z.infer<typeof SearchPriceCatalogSchema>) {
    let query = supabase
        .from("price_catalog")
        .select("*")
        .eq("active", true)
        .limit(params.limit || 10);

    // Text search
    if (params.query) {
        query = query.or(`product_name.ilike.%${params.query}%,description.ilike.%${params.query}%,category.ilike.%${params.query}%`);
    }

    if (params.category) {
        query = query.eq("category", params.category);
    }

    const { data, error } = await query;

    if (error) throw new Error(`Failed to search catalog: ${error.message}`);

    return data;
}

async function getLeadHistory(params: z.infer<typeof GetLeadHistorySchema>) {
    const { data, error } = await supabase
        .from("lead_history")
        .select(`
      *,
      changed_by:profiles(full_name)
    `)
        .eq("lead_id", params.lead_id)
        .order("created_at", { ascending: false });

    if (error) throw new Error(`Failed to fetch history: ${error.message}`);
    return data;
}

async function getPipelineStats() {
    const { data, error } = await supabase
        .from("leads")
        .select(`
      stage_id,
      custom_fields,
      stage:pipeline_stages(name, slug, color, position)
    `);

    if (error) throw new Error(`Failed to fetch stats: ${error.message}`);

    // Aggregate by stage
    const stats: Record<string, { count: number; total_value: number; stage_name: string }> = {};

    for (const lead of data || []) {
        const slug = (lead.stage as any)?.slug || "unknown";
        if (!stats[slug]) {
            stats[slug] = { count: 0, total_value: 0, stage_name: (lead.stage as any)?.name };
        }
        stats[slug].count++;
        const value = (lead.custom_fields as any)?.valor_estimado;
        if (value) stats[slug].total_value += Number(value);
    }

    return stats;
}

// ================== TOOL DEFINITIONS ==================

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "get_leads",
                description: "Get leads from the CRM pipeline. Can filter by stage and vendedor.",
                inputSchema: {
                    type: "object",
                    properties: {
                        stage_slug: {
                            type: "string",
                            description: "Filter by stage: lead, orcamento, negociacao, fechado, curioso",
                        },
                        vendedor_id: {
                            type: "string",
                            description: "Filter by vendedor (seller) UUID",
                        },
                        limit: {
                            type: "number",
                            description: "Max results (default 50)",
                        },
                    },
                },
            },
            {
                name: "update_lead_stage",
                description: "Move a lead to a different pipeline stage.",
                inputSchema: {
                    type: "object",
                    properties: {
                        lead_id: {
                            type: "string",
                            description: "UUID of the lead",
                        },
                        new_stage_slug: {
                            type: "string",
                            description: "New stage: lead, orcamento, negociacao, fechado, curioso",
                        },
                    },
                    required: ["lead_id", "new_stage_slug"],
                },
            },
            {
                name: "update_lead_custom_fields",
                description: "Update custom fields on a lead (tipo_tinta, quantidade_litros, cor_desejada, valor_estimado, etc).",
                inputSchema: {
                    type: "object",
                    properties: {
                        lead_id: {
                            type: "string",
                            description: "UUID of the lead",
                        },
                        custom_fields: {
                            type: "object",
                            description: "Key-value pairs to update",
                        },
                    },
                    required: ["lead_id", "custom_fields"],
                },
            },
            {
                name: "create_lead",
                description: "Create a new lead in the CRM.",
                inputSchema: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "Contact name" },
                        phone: { type: "string", description: "Phone number" },
                        email: { type: "string", description: "Email" },
                        stage_slug: { type: "string", description: "Initial stage (default: lead)" },
                        vendedor_id: { type: "string", description: "UUID of vendedor" },
                        custom_fields: { type: "object", description: "Custom fields" },
                        notes: { type: "string", description: "Notes" },
                    },
                    required: ["name", "vendedor_id"],
                },
            },
            {
                name: "search_price_catalog",
                description: "Search the paint price catalog by product name, category, or description.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Search term" },
                        category: { type: "string", description: "Filter by category" },
                        limit: { type: "number", description: "Max results" },
                    },
                    required: ["query"],
                },
            },
            {
                name: "get_lead_history",
                description: "Get the activity history for a lead (stage changes, updates).",
                inputSchema: {
                    type: "object",
                    properties: {
                        lead_id: { type: "string", description: "UUID of the lead" },
                    },
                    required: ["lead_id"],
                },
            },
            {
                name: "get_pipeline_stats",
                description: "Get statistics for each pipeline stage (lead count, total value).",
                inputSchema: {
                    type: "object",
                    properties: {},
                },
            },
        ],
    };
});

// ================== TOOL EXECUTION ==================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        let result: unknown;

        switch (name) {
            case "get_leads":
                result = await getLeads(GetLeadsSchema.parse(args));
                break;
            case "update_lead_stage":
                result = await updateLeadStage(UpdateLeadStageSchema.parse(args));
                break;
            case "update_lead_custom_fields":
                result = await updateLeadCustomFields(UpdateLeadCustomFieldsSchema.parse(args));
                break;
            case "create_lead":
                result = await createLead(CreateLeadSchema.parse(args));
                break;
            case "search_price_catalog":
                result = await searchPriceCatalog(SearchPriceCatalogSchema.parse(args));
                break;
            case "get_lead_history":
                result = await getLeadHistory(GetLeadHistorySchema.parse(args));
                break;
            case "get_pipeline_stats":
                result = await getPipelineStats();
                break;
            default:
                throw new Error(`Unknown tool: ${name}`);
        }

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: message }),
                },
            ],
            isError: true,
        };
    }
});

// ================== RESOURCES ==================

server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
        resources: [
            {
                uri: "crm://stages",
                name: "Pipeline Stages",
                description: "All pipeline stages with colors",
                mimeType: "application/json",
            },
            {
                uri: "crm://custom-fields",
                name: "Custom Field Definitions",
                description: "Available custom fields for leads",
                mimeType: "application/json",
            },
        ],
    };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "crm://stages") {
        const { data } = await supabase
            .from("pipeline_stages")
            .select("*")
            .order("position");

        return {
            contents: [
                {
                    uri,
                    mimeType: "application/json",
                    text: JSON.stringify(data, null, 2),
                },
            ],
        };
    }

    if (uri === "crm://custom-fields") {
        const { data } = await supabase
            .from("custom_field_definitions")
            .select("*")
            .order("position");

        return {
            contents: [
                {
                    uri,
                    mimeType: "application/json",
                    text: JSON.stringify(data, null, 2),
                },
            ],
        };
    }

    throw new Error(`Resource not found: ${uri}`);
});

// ================== START SERVER ==================

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Outlet CRM MCP Server running on stdio");
}

main().catch(console.error);
