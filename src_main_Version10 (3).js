// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, Dataset, KeyValueStore } from 'crawlee';
import crypto from 'crypto';

// The init() call configures the Actor for its environment
await Actor.init();

// Structure of input is defined in input_schema.json
const {
    startUrls = [{ url: 'https://docs.python.org/3/' }],
    monitoredProducts = ['React', 'Node.js', 'Python', 'TypeScript'],
    checkInterval = 12,
    detectChanges = true,
    detectNewPages = true,
    detectRemovedPages = true,
    detectStructureChanges = true,
    detectAPIChanges = true,
    extractCodeExamples = true,
    trackVersions = true,
    extractDeprecations = true,
    extractReleaseNotes = true,
    compareWithPrevious = true,
    calculateChangeScore = true,
    notificationLevel = 'major',
    alertOnBreakingChanges = true,
    includeMetadata = true,
    generateSummary = true,
    maxPagesToScan = 500,
    outputFormat = 'json',
} = (await Actor.getInput()) ?? {};

// Proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration();

// Statistics tracking
const statistics = {
    documentsScanned: 0,
    changesDetected: 0,
    breakingChanges: 0,
    newFeatures: 0,
    deprecations: 0,
    structureChanges: 0,
    errors: 0,
    startTime: new Date(),
};

// Global data collections
const previousState = new Map(); // Store previous document state
const currentState = new Map(); // Current document state
const changesDetected = [];
const agentAlerts = [];
const changeHistory = [];

// Helper function to generate content hash
function generateContentHash(content) {
    return crypto.createHash('md5').update(content).digest('hex');
}

// Helper function to detect API changes
function detectAPIChanges(oldContent, newContent) {
    const apiPattern = /(?:function|const|class|interface|async)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:\(|=|:)/g;

    const oldAPIs = new Set();
    const newAPIs = new Set();

    let match;
    while ((match = apiPattern.exec(oldContent)) !== null) {
        oldAPIs.add(match[1]);
    }

    apiPattern.lastIndex = 0;
    while ((match = apiPattern.exec(newContent)) !== null) {
        newAPIs.add(match[1]);
    }

    const added = [];
    const removed = [];

    newAPIs.forEach((api) => {
        if (!oldAPIs.has(api)) added.push(api);
    });

    oldAPIs.forEach((api) => {
        if (!newAPIs.has(api)) removed.push(api);
    });

    return { added, removed };
}

// Helper function to extract deprecation notices
function extractDeprecations(content) {
    const deprecationPatterns = [
        /deprecated[:\s]+([^.\n]+)/gi,
        /no longer[:\s]+([^.\n]+)/gi,
        /removed[:\s]+([^.\n]+)/gi,
        /use.*instead/gi,
    ];

    const deprecations = [];

    deprecationPatterns.forEach((pattern) => {
        let match;
        while ((match = pattern.exec(content)) !== null) {
            deprecations.push({
                text: match[0],
                context: match[1] || match[0],
            });
        }
    });

    return deprecations;
}

// Helper function to extract code examples
function extractCodeExamples(content) {
    const codeBlockPattern = /```[\s\S]*?```|<code>[\s\S]*?<\/code>/g;
    const codeBlocks = content.match(codeBlockPattern) || [];

    return codeBlocks.map((block, idx) => ({
        id: `code_${idx}`,
        content: block.slice(0, 200),
        language: detectLanguage(block),
    }));
}

// Helper function to detect code language
function detectLanguage(code) {
    if (code.includes('import React') || code.includes('jsx')) return 'javascript/jsx';
    if (code.includes('const ') || code.includes('function ')) return 'javascript';
    if (code.includes('def ') || code.includes('import ')) return 'python';
    if (code.includes('interface ') || code.includes('type ')) return 'typescript';
    return 'unknown';
}

// Helper function to calculate change severity
function calculateChangeSeverity(changes) {
    let score = 0;

    if (changes.apiRemoved) score += 50; // Breaking
    if (changes.deprecations && changes.deprecations.length > 0) score += 25; // Major
    if (changes.apiAdded) score += 10; // Minor
    if (changes.contentChanged) score += 5; // Patch
    if (changes.structureChanged) score += 15; // Major

    if (score >= 50) return 'critical';
    if (score >= 25) return 'major';
    if (score >= 10) return 'minor';
    return 'patch';
}

// Helper function to generate change summary
function generateChangeSummary(changes, product) {
    const summary = [];

    if (changes.apiAdded && changes.apiAdded.length > 0) {
        summary.push(`Added ${changes.apiAdded.length} new API methods: ${changes.apiAdded.join(', ')}`);
    }

    if (changes.apiRemoved && changes.apiRemoved.length > 0) {
        summary.push(`⚠️ Removed ${changes.apiRemoved.length} API methods: ${changes.apiRemoved.join(', ')}`);
    }

    if (changes.deprecations && changes.deprecations.length > 0) {
        summary.push(`⚡ ${changes.deprecations.length} deprecation notices found`);
    }

    if (changes.newPages && changes.newPages.length > 0) {
        summary.push(`Added ${changes.newPages.length} new documentation pages`);
    }

    if (changes.removedPages && changes.removedPages.length > 0) {
        summary.push(`Removed ${changes.removedPages.length} documentation pages`);
    }

    return summary;
}

// Helper function to extract page metadata
function extractPageMetadata($, url) {
    const metadata = {
        title: $('h1').first().text() || $('title').text(),
        lastUpdated: $('[class*="updated"], [class*="modified"], time').attr('datetime') || new Date().toISOString(),
        version: extractVersionFromURL(url),
        category: extractCategoryFromURL(url),
        url,
    };

    return metadata;
}

// Helper function to extract version from URL
function extractVersionFromURL(url) {
    const versionMatch = url.match(/v(\d+(?:\.\d+)?)|(\d+\.\d+)|latest|stable|main/i);
    return versionMatch ? versionMatch[0] : 'unknown';
}

// Helper function to extract category from URL
function extractCategoryFromURL(url) {
    const segments = url.split('/').filter((s) => s.length > 0);
    return segments[segments.length - 1] || 'index';
}

// Helper function to detect structural changes
function detectStructureChanges(oldStructure, newStructure) {
    const oldHeadings = oldStructure.match(/<h[1-6][^>]*>[^<]+<\/h[1-6]>/gi) || [];
    const newHeadings = newStructure.match(/<h[1-6][^>]*>[^<]+<\/h[1-6]>/gi) || [];

    return {
        added: newHeadings.filter((h) => !oldHeadings.includes(h)),
        removed: oldHeadings.filter((h) => !newHeadings.includes(h)),
        changed: oldHeadings.length !== newHeadings.length,
    };
}

// Helper function to detect content changes
function detectContentChanges(oldContent, newContent) {
    const oldHash = generateContentHash(oldContent);
    const newHash = generateContentHash(newContent);

    return {
        changed: oldHash !== newHash,
        oldHash,
        newHash,
    };
}

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: maxPagesToScan,
    async requestHandler({ request, $, log }) {
        const url = request.loadedUrl;
        log.info(`Scanning documentation: ${url}`);

        try {
            // Extract page content
            const pageContent = $('body').html() || '';
            const pageText = $('body').text() || '';

            // Skip very short pages (likely not documentation)
            if (pageText.length < 100) {
                log.debug(`Page too short, skipping: ${url}`);
                return;
            }

            // Extract metadata
            const metadata = extractPageMetadata($, url);

            // Generate current hash
            const currentHash = generateContentHash(pageContent);

            // Check for changes
            const changeData = {
                pageId: crypto.createHash('md5').update(url).digest('hex').slice(0, 16),
                url,
                ...metadata,
                currentHash,
                changes: {
                    contentChanged: false,
                    apiAdded: [],
                    apiRemoved: [],
                    newPages: [],
                    removedPages: [],
                    structureChanged: false,
                    deprecations: [],
                    codeExamples: [],
                },
                severity: 'patch',
            };

            // Check if we have previous state for this page
            if (previousState.has(url)) {
                const previousHash = previousState.get(url).hash;
                const previousContent = previousState.get(url).content;

                // Detect content changes
                const contentChanges = detectContentChanges(previousContent, pageContent);
                changeData.changes.contentChanged = contentChanges.changed;

                if (detectChanges && contentChanges.changed) {
                    // Detect API changes
                    if (detectAPIChanges) {
                        const apiChanges = detectAPIChanges(previousContent, pageContent);
                        changeData.changes.apiAdded = apiChanges.added;
                        changeData.changes.apiRemoved = apiChanges.removed;
                    }

                    // Detect structure changes
                    if (detectStructureChanges) {
                        const structureChanges = detectStructureChanges(previousContent, pageContent);
                        changeData.changes.structureChanged = structureChanges.changed;
                    }

                    // Extract deprecations
                    if (extractDeprecations) {
                        changeData.changes.deprecations = extractDeprecations(pageContent);
                    }

                    // Extract code examples
                    if (extractCodeExamples) {
                        changeData.changes.codeExamples = extractCodeExamples(pageContent);
                    }

                    // Calculate severity
                    changeData.severity = calculateChangeSeverity(changeData.changes);

                    // Save change record
                    changesDetected.push(changeData);
                    statistics.changesDetected++;

                    if (changeData.changes.apiRemoved.length > 0) {
                        statistics.breakingChanges++;
                    }
                    if (changeData.changes.apiAdded.length > 0) {
                        statistics.newFeatures++;
                    }
                    if (changeData.changes.deprecations.length > 0) {
                        statistics.deprecations++;
                    }
                    if (changeData.changes.structureChanged) {
                        statistics.structureChanges++;
                    }

                    // Generate alert if needed
                    if (
                        (notificationLevel === 'all') ||
                        (notificationLevel === 'major' && ['major', 'critical'].includes(changeData.severity)) ||
                        (notificationLevel === 'critical' && changeData.severity === 'critical') ||
                        (alertOnBreakingChanges && changeData.changes.apiRemoved.length > 0)
                    ) {
                        const summary = generateChangeSummary(changeData.changes, metadata.version);
                        const alert = {
                            alertId: crypto.createHash('md5').update(`${url}_${Date.now()}`).digest('hex').slice(0, 12),
                            timestamp: new Date().toISOString(),
                            product: metadata.version,
                            severity: changeData.severity,
                            type: changeData.changes.apiRemoved.length > 0 ? 'breaking' : 'update',
                            summary: summary.join(' | '),
                            details: changeData.changes,
                            url,
                            actionRequired: changeData.changes.apiRemoved.length > 0,
                        };

                        agentAlerts.push(alert);

                        // Save to dataset
                        await Dataset.pushData({
                            type: 'change',
                            changeId: changeData.pageId,
                            product: metadata.version,
                            changeType: changeData.changes.apiRemoved.length > 0 ? 'breaking' : 'update',
                            severity: changeData.severity,
                            detectedAt: new Date().toISOString(),
                            affectedPages: 1,
                            description: summary[0] || 'Documentation updated',
                            url,
                        });

                        // Save breaking change alert
                        if (changeData.changes.apiRemoved.length > 0) {
                            await Dataset.pushData({
                                type: 'breaking',
                                changeId: changeData.pageId,
                                product: metadata.version,
                                apiName: changeData.changes.apiRemoved.join(', '),
                                impact: 'API methods removed - code may break',
                                migrationPath: `Review ${url} for migration guide`,
                                detectedAt: new Date().toISOString(),
                            });
                        }

                        // Save new features
                        if (changeData.changes.apiAdded.length > 0) {
                            changeData.changes.apiAdded.forEach((api, idx) => {
                                Dataset.pushData({
                                    type: 'feature',
                                    featureId: `${changeData.pageId}_${idx}`,
                                    product: metadata.version,
                                    featureName: api,
                                    category: 'API',
                                    documentation: url,
                                    version: metadata.version,
                                });
                            });
                        }

                        log.info(`🚨 Change detected: ${summary[0]}`);
                    }
                }
            }

            // Store current state
            currentState.set(url, {
                hash: currentHash,
                content: pageContent,
                metadata,
            });

            statistics.documentsScanned++;

            // Extract and enqueue links to other documentation pages
            $('a[href]').each((i, el) => {
                if (statistics.documentsScanned >= maxPagesToScan) return false;

                let href = $(el).attr('href');
                if (!href) return true;

                // Convert relative URLs to absolute
                if (href.startsWith('/')) {
                    const urlObj = new URL(url);
                    href = `${urlObj.origin}${href}`;
                } else if (!href.startsWith('http')) {
                    try {
                        href = new URL(href, url).toString();
                    } catch {
                        return true;
                    }
                }

                // Only follow links on same domain/documentation site
                if (href.includes(new URL(url).hostname)) {
                    crawler.addRequests([{ url: href }]).catch(() => {});
                }

                return true;
            });
        } catch (error) {
            log.error(`Error scanning documentation: ${error.message}`);
            statistics.errors++;
        }
    },

    errorHandler({ request, error, log }) {
        log.error(`Request failed: ${request.url}`, error);
        statistics.errors++;
    },
});

// Run the crawler
try {
    await crawler.run(startUrls);
} catch (error) {
    console.error('Crawler error:', error);
    statistics.errors++;
}

// Generate comprehensive reports
const kvStore = await KeyValueStore.open();

// Prepare change report
const changeReport = {
    reportDate: new Date().toISOString(),
    checkInterval,
    scanDuration: new Date() - statistics.startTime,
    summary: {
        documentsScanned: statistics.documentsScanned,
        changesDetected: statistics.changesDetected,
        breakingChanges: statistics.breakingChanges,
        newFeatures: statistics.newFeatures,
        deprecationsFound: statistics.deprecations,
        structureChanges: statistics.structureChanges,
    },
    productsSummary: monitoredProducts.map((product) => ({
        name: product,
        changesCount: changesDetected.filter((c) => c.url.includes(product.toLowerCase())).length,
    })),
    topChanges: changesDetected
        .sort((a, b) => {
            const severityOrder = { critical: 0, major: 1, minor: 2, patch: 3 };
            return severityOrder[a.severity] - severityOrder[b.severity];
        })
        .slice(0, 20),
    breakingChanges: changesDetected.filter((c) => c.changes.apiRemoved.length > 0),
    deprecations: changesDetected
        .filter((c) => c.changes.deprecations.length > 0)
        .slice(0, 10),
};

await kvStore.setValue('CHANGE_REPORT', JSON.stringify(changeReport, null, 2));

// Prepare agent alerts
const agentAlertsSummary = {
    reportDate: new Date().toISOString(),
    totalAlerts: agentAlerts.length,
    criticalAlerts: agentAlerts.filter((a) => a.severity === 'critical').length,
    majorAlerts: agentAlerts.filter((a) => a.severity === 'major').length,
    actionRequired: agentAlerts.filter((a) => a.actionRequired).length,
    alerts: agentAlerts,
};

await kvStore.setValue('AGENT_ALERTS', JSON.stringify(agentAlertsSummary, null, 2));

// Prepare change history
changeHistory.push({
    timestamp: new Date().toISOString(),
    changes: changesDetected,
    statistics,
});

await kvStore.setValue('CHANGE_HISTORY', JSON.stringify(changeHistory, null, 2));

console.log('\n=== Documentation Change Monitoring Complete ===');
console.log(`Documents scanned: ${statistics.documentsScanned}`);
console.log(`Changes detected: ${statistics.changesDetected}`);
console.log(`Breaking changes: ${statistics.breakingChanges}`);
console.log(`New features: ${statistics.newFeatures}`);
console.log(`Deprecations: ${statistics.deprecations}`);
console.log(`Structure changes: ${statistics.structureChanges}`);
console.log(`Agent alerts generated: ${agentAlerts.length}`);
console.log(`Critical alerts: ${agentAlerts.filter((a) => a.severity === 'critical').length}`);
console.log(`Errors: ${statistics.errors}`);

if (agentAlerts.length > 0) {
    console.log('\n🚨 Critical Changes Detected:');
    agentAlerts
        .filter((a) => a.severity === 'critical')
        .slice(0, 5)
        .forEach((alert) => {
            console.log(`  - ${alert.summary}`);
        });
}

// Gracefully exit the Actor process
await Actor.exit();