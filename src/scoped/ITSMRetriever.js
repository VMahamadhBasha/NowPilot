// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0
var ITSMRetriever = Class.create();

/**
 * Deterministic, authorized retriever for ITSM historical incidents and published knowledge articles.
 * Enforces user-session ACLs via GlideRecordSecure, multi-factor transparent scoring,
 * bounded queries, and strict exclusion of draft/expired/unauthorized records.
 */
ITSMRetriever.STOP_WORDS = {
    'the': 1, 'and': 1, 'for': 1, 'with': 1, 'from': 1, 'that': 1, 'this': 1,
    'have': 1, 'unable': 1, 'cannot': 1, 'not': 1, 'when': 1, 'after': 1,
    'issue': 1, 'error': 1, 'please': 1, 'help': 1, 'user': 1, 'incident': 1,
    'problem': 1, 'failing': 1, 'failed': 1, 'system': 1, 'ticket': 1
};

ITSMRetriever.tokenize = function(text) {
    if (!text) return [];
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(function(w) { return w.length >= 3 && !ITSMRetriever.STOP_WORDS[w]; })
        .slice(0, 10);
};

ITSMRetriever.prototype = {
    initialize: function() {},

    /**
     * Search authorized historical incidents similar to the provided criteria.
     * Evaluates text keywords, category, subcategory, CMDB CI, and resolution availability.
     */
    searchSimilarIncidents: function(params) {
        params = params || {};
        var limit = Math.min(parseInt(params.limit, 10) || 5, 10);
        var searchSource = null;
        var excludeSysId = '';
        var searchWords = [];
        var targetCategory = params.category || '';
        var targetSubcategory = params.subcategory || '';
        var targetCi = params.cmdb_ci || '';

        // If an existing incident sys_id or number is provided, read its attributes as the user
        if (params.incident_sys_id || params.incident_number) {
            var srcGr = new GlideRecordSecure('incident');
            var found = false;
            if (params.incident_sys_id && srcGr.get(params.incident_sys_id)) found = true;
            else if (params.incident_number) {
                srcGr.addQuery('number', params.incident_number);
                srcGr.setLimit(1);
                srcGr.query();
                if (srcGr.next()) found = true;
            }

            if (found) {
                searchSource = {
                    sys_id: srcGr.getUniqueValue(),
                    number: srcGr.getValue('number') || '',
                    short_description: srcGr.getValue('short_description') || '',
                    category: srcGr.getValue('category') || '',
                    subcategory: srcGr.getValue('subcategory') || '',
                    cmdb_ci: srcGr.getValue('cmdb_ci') || ''
                };
                excludeSysId = searchSource.sys_id;
                if (!targetCategory) targetCategory = searchSource.category;
                if (!targetSubcategory) targetSubcategory = searchSource.subcategory;
                if (!targetCi) targetCi = searchSource.cmdb_ci;
                searchWords = ITSMRetriever.tokenize(searchSource.short_description);
            }
        }

        // If direct search text or query provided, combine or override tokens
        if (params.text || params.query) {
            var directWords = ITSMRetriever.tokenize(params.text || params.query);
            searchWords = searchWords.concat(directWords).filter(function(v, i, a) { return a.indexOf(v) === i; }).slice(0, 8);
        }

        if (!searchWords.length && !targetCategory && !targetCi) {
            return {
                ok: true,
                count: 0,
                results: [],
                message: 'No sufficient search terms or incident context available to find similar incidents.'
            };
        }

        var gr = new GlideRecordSecure('incident');
        // Prefer historical resolved or closed incidents with resolution documentation
        if (params.only_resolved !== false) {
            gr.addEncodedQuery('stateIN6,7^close_notesISNOTEMPTY');
        }

        var orParts = [];
        searchWords.forEach(function(w) {
            orParts.push('short_descriptionLIKE' + w);
        });
        if (targetCategory) orParts.push('category=' + targetCategory);
        if (targetCi) orParts.push('cmdb_ci=' + targetCi);

        if (orParts.length) {
            gr.addEncodedQuery(orParts.join('^OR'));
        }

        if (excludeSysId) {
            gr.addQuery('sys_id', '!=', excludeSysId);
        }

        gr.orderByDesc('sys_updated_on');
        gr.setLimit(limit * 3); // Bounded query window
        gr.query();

        var candidates = [];
        while (gr.next()) {
            if (!gr.canRead()) continue;
            var num = gr.getValue('number') || '';
            var sd = String(gr.getValue('short_description') || '');
            var desc = String(gr.getValue('description') || '');
            var cat = gr.getValue('category') || '';
            var subcat = gr.getValue('subcategory') || '';
            var ci = gr.getValue('cmdb_ci') || '';
            var ciDisplay = gr.getDisplayValue('cmdb_ci') || ci;
            var closeCode = gr.getValue('close_code') || '';
            var closeNotes = String(gr.getValue('close_notes') || '');

            // Transparent Multi-Factor Relevance Scoring
            var score = 0;
            var matchReasons = [];

            // 1. Keyword overlap (0.45 weight)
            var matchedKeywords = 0;
            var combinedText = (sd + ' ' + desc).toLowerCase();
            searchWords.forEach(function(kw) {
                if (combinedText.indexOf(kw) >= 0) matchedKeywords++;
            });
            var keywordScore = 0;
            if (searchWords.length > 0 && matchedKeywords > 0) {
                keywordScore = (matchedKeywords / searchWords.length) * 0.45;
                score += keywordScore;
                matchReasons.push(matchedKeywords + '/' + searchWords.length + ' keywords matched');
            }

            // 2. Category / Subcategory matching (0.20 weight)
            var categoryScore = 0;
            if (targetCategory && cat === targetCategory) {
                categoryScore += 0.15;
                matchReasons.push('Matching category (' + cat + ')');
                if (targetSubcategory && subcat === targetSubcategory) {
                    categoryScore += 0.05;
                    matchReasons.push('Matching subcategory');
                }
            }
            score += categoryScore;

            // 3. Configuration Item matching (0.25 weight)
            var ciScore = 0;
            if (targetCi && ci === targetCi) {
                ciScore = 0.25;
                score += ciScore;
                matchReasons.push('Matching CI (' + ciDisplay + ')');
            }

            // 4. Documented resolution notes quality (0.10 weight)
            var resolutionScore = 0;
            if (closeNotes.length >= 20) {
                resolutionScore = 0.10;
                score += resolutionScore;
                matchReasons.push('Verified resolution notes documented');
            }

            candidates.push({
                sys_id: gr.getUniqueValue(),
                number: num,
                short_description: sd,
                category: cat,
                subcategory: subcat,
                cmdb_ci: ciDisplay,
                state: gr.getDisplayValue('state') || gr.getValue('state'),
                close_code: closeCode,
                close_notes: closeNotes,
                score: Math.round(score * 100) / 100,
                relevance_score: Math.round(score * 100) / 100,
                scoring_breakdown: {
                    keyword_score: Math.round(keywordScore * 100) / 100,
                    category_score: Math.round(categoryScore * 100) / 100,
                    cmdb_ci_score: Math.round(ciScore * 100) / 100,
                    resolution_score: Math.round(resolutionScore * 100) / 100
                },
                relevance_reasons: matchReasons.join(' · ')
            });
        }

        // Sort candidates by score descending
        candidates.sort(function(a, b) { return b.score - a.score; });
        var topResults = candidates.slice(0, limit);

        return {
            ok: true,
            count: topResults.length,
            search_keywords: searchWords,
            results: topResults,
            message: topResults.length ? 'Found ' + topResults.length + ' similar incidents.' : 'No similar historical incidents found matching criteria.'
        };
    },

    /**
     * Search authorized published knowledge articles.
     * Strictly verifies workflow_state=published and validity dates.
     */
    searchKnowledgeArticles: function(params) {
        params = params || {};
        var query = String(params.query || '').trim();
        var limit = Math.min(parseInt(params.limit, 10) || 5, 10);
        var keywords = ITSMRetriever.tokenize(query);

        if (!keywords.length) {
            return {
                ok: true,
                count: 0,
                results: [],
                message: 'No keywords provided for knowledge article search.'
            };
        }

        var gr = new GlideRecordSecure('kb_knowledge');
        // Mandatory ServiceNow knowledge criteria: strictly published and non-expired
        gr.addQuery('workflow_state', 'published');
        gr.addEncodedQuery('valid_to>=javascript:gs.beginningOfToday()^ORvalid_toISEMPTY');

        var orParts = keywords.map(function(k) {
            return 'short_descriptionLIKE' + k + '^ORtextLIKE' + k;
        });
        gr.addEncodedQuery(orParts.join('^OR'));
        gr.orderByDesc('sys_view_count');
        gr.setLimit(limit * 3);
        gr.query();

        var articles = [];
        while (gr.next()) {
            if (!gr.canRead()) continue;
            var num = gr.getValue('number') || '';
            var title = gr.getValue('short_description') || '';
            var text = String(gr.getValue('text') || '');
            var kbBase = gr.getDisplayValue('kb_knowledge_base') || '';
            var topic = gr.getValue('topic') || '';
            var category = gr.getDisplayValue('category') || '';
            var published = gr.getValue('published') || '';

            // Strip HTML tags for clean text snippets
            var plainText = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

            var matched = 0;
            var fullSearchText = (title + ' ' + plainText).toLowerCase();
            keywords.forEach(function(k) {
                if (fullSearchText.indexOf(k) >= 0) matched++;
            });

            var score = Math.round((matched / keywords.length) * 100) / 100;
            if (matched === 0) continue;

            articles.push({
                sys_id: gr.getUniqueValue(),
                number: num,
                title: title,
                knowledge_base: kbBase,
                topic: topic,
                category: category,
                published: published,
                text_snippet: plainText.substring(0, 400),
                score: score,
                relevance_reasons: matched + '/' + keywords.length + ' query keywords matched'
            });
        }

        articles.sort(function(a, b) { return b.score - a.score; });
        var topArticles = articles.slice(0, limit);

        return {
            ok: true,
            count: topArticles.length,
            keywords: keywords,
            results: topArticles,
            message: topArticles.length ? 'Found ' + topArticles.length + ' published knowledge articles.' : 'No published knowledge articles found matching criteria.'
        };
    },

    /**
     * Combined ITSM evidence retrieval for incidents and knowledge.
     */
    retrieveEvidence: function(params) {
        params = params || {};
        var incRes = this.searchSimilarIncidents(params);
        var kbQuery = params.query || params.text || (params.incident_data && params.incident_data.short_description) || '';
        var kbRes = this.searchKnowledgeArticles({ query: kbQuery, limit: params.limit });

        return {
            ok: true,
            incidents: incRes.results || [],
            articles: kbRes.results || [],
            has_evidence: (incRes.results && incRes.results.length > 0) || (kbRes.results && kbRes.results.length > 0)
        };
    },

    type: 'ITSMRetriever'
};
