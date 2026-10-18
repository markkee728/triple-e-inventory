function escapeHTML(value) {

    if (value === null || value === undefined) {
        return "";
    }

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

}


function formatNumber(value) {

    return new Intl.NumberFormat("en-PH").format(value);

}


function formatCurrency(value) {

    return new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
        maximumFractionDigits: 2
    }).format(value);

}


/* =====================================================
   PAGE NAVIGATION
===================================================== */

const pageInformation = {

    dashboard: {
        title: "Dashboard",
        subtitle: "Overview"
    },

    notifications: {
        title: "Notifications",
        subtitle: "Alerts"
    },

    "sales-overview": { title: "Sales & Transactions", subtitle: "Combined sales summary and transaction ledger" },

    orders: {
        title: "Online Orders",
        subtitle: "Shop orders, delivery and pickup"
    },

    sales: {
        title: "POS Management",
        subtitle: "POS sales and cashier cash shifts"
    },

    inventory: {
        title: "Inventory Monitoring",
        subtitle: "Finance Admin Officer Access"
    },

    stockflow: {
        title: "Stock In / Out",
        subtitle: "Movement entry"
    },

    products: {
        title: "Products",
        subtitle: "Manage products and inventory information"
    },

    suppliers: {
        title: "Suppliers",
        subtitle: "Manage supplier information"
    },

    dispatch: {
        title: "Dispatch",
        subtitle: "Release finished goods against purchase orders"
    },

    quotes: {
        title: "Quote Requests",
        subtitle: "Bulk orders and custom sizes"
    },

    reviews: {
        title: "Product Reviews",
        subtitle: "Verified customer reviews"
    },

    customers: { title: "Customer Profiles", subtitle: "Registered customer directory" },

    usermgmt: {
        title: "User Management",
        subtitle: "Manage user accounts"
    },

    auditlog: {
        title: "Audit Log",
        subtitle: "System activity record"
    },

    reports: {
        title: "Reports",
        subtitle: "View reports and analytics"
    }

};


function navigateToPage(pageId) {

    const navItems = document.querySelectorAll(".nav-item");
    const pages = document.querySelectorAll(".page");

    navItems.forEach(item => {
        item.classList.toggle("active", item.dataset.page === pageId);
    });
    const parent = document.querySelector('.sales-parent');
    if (parent) parent.classList.toggle('sales-section-active', ['sales-overview','sales','orders','quotes'].includes(pageId));
    document.querySelectorAll('.sales-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.page === pageId));

    pages.forEach(page => {
        page.classList.toggle(
            "active-page",
            page.id === pageId
        );
    });

    const information = pageInformation[pageId];

    if (!information) {
        return;
    }

    const pageTitle = document.getElementById("pageTitle");
    const pageSubtitle = document.getElementById("pageSubtitle");

    if (pageTitle) {
        pageTitle.textContent = information.title;
    }

    if (pageSubtitle) {
        pageSubtitle.textContent = information.subtitle;
    }

}


function initNavigation() {

    document.querySelectorAll(".nav-item, .sales-tab").forEach(item => {

        item.addEventListener("click", () => {
            navigateToPage(item.dataset.page);
        });

    });

}


/* =====================================================
   QUICK ACTIONS
===================================================== */

const UI_ICONS = {
    plus: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
    package: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
    building: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4M10 10h4M10 14h4M10 18h4"/></svg>',
    cart: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>',
    chart: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
    arrow: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>'
};

const quickActionsConfig = [
    {
        icon: "plus",
        title: "Record Stock Movement",
        sub: "Log a stock in or stock out",
        targetPage: "stockflow"
    },
    {
        icon: "package",
        title: "Add New Product",
        sub: "Create a product record",
        targetPage: "products"
    },
    {
        icon: "building",
        title: "Onboard Supplier",
        sub: "Add a new supplier",
        targetPage: "suppliers"
    },
    {
        icon: "cart",
        title: "Record Sales Transaction",
        sub: "Create a new sales transaction",
        targetPage: "sales"
    },
    {
        icon: "chart",
        title: "View reports",
        sub: "Daily, weekly, monthly, yearly, or custom",
        targetPage: "reports"
    }
];


function renderQuickActions() {

    const container =
        document.getElementById("quickActionsList");

    if (!container) {
        return;
    }

    container.innerHTML = quickActionsConfig.map((action, index) => `

        <div
            class="quick-action-item"
            data-index="${index}"
        >

            <div class="quick-action-icon">
                ${UI_ICONS[action.icon] || ""}
            </div>

            <div class="quick-action-body">

                <div class="quick-action-title">
                    ${escapeHTML(action.title)}
                </div>

                <div class="quick-action-sub">
                    ${escapeHTML(action.sub)}
                </div>

            </div>

            <div class="quick-action-arrow">
                ${UI_ICONS.arrow}
            </div>

        </div>

    `).join("");

    container
        .querySelectorAll(".quick-action-item")
        .forEach(item => {

            item.addEventListener("click", () => {

                const action =
                    quickActionsConfig[
                        Number(item.dataset.index)
                    ];

                if (action.targetPage) {
                    navigateToPage(action.targetPage);
                }

            });

        });

}


/* =====================================================
   DASHBOARD UI
   TEMPORARY DISPLAY VALUES ONLY
===================================================== */

const dashboardMockDisplay = {

    totalSkus: 14,
    departments: 4,
    lowStock: 6,
    movements: 6,
    inventoryValue: 0,
    orders: null,
    ordersOpen: 0,
    posSales: 0

};


function renderDashboardStats() {

    const totalSkus =
        document.getElementById("totalSkus");

    const skuFoot =
        document.getElementById("skuFoot");

    const lowStockAlerts =
        document.getElementById("lowStockAlerts");

    const lowStockFoot =
        document.getElementById("lowStockFoot");

    const dashMovements =
        document.getElementById("dashMovements");

    const dashMovementsFoot =
        document.getElementById("dashMovementsFoot");

    const totalOrders=
        document.getElementById("totalOrders");

    const totalOrdersFoot =
        document.getElementById("totalOrdersFoot");


    if (totalSkus) {
        totalSkus.textContent =
            dashboardMockDisplay.totalSkus;
    }

    if (skuFoot) {
        skuFoot.textContent =
            `${dashboardMockDisplay.departments} departments tracked`;
    }

    if (lowStockAlerts) {
        lowStockAlerts.textContent =
            dashboardMockDisplay.lowStock;
    }

    if (lowStockFoot) {
        lowStockFoot.textContent =
            "At or below reorder";
    }

    if (dashMovements) {
        dashMovements.textContent =
            dashboardMockDisplay.movements;
    }

    if (dashMovementsFoot) {
        dashMovementsFoot.textContent =
            "Stock in/out entries";
    }

    if (totalOrders) {
        totalOrders.textContent =
            dashboardMockDisplay.orders === null
                ? "—"
                : dashboardMockDisplay.orders;
    }

    if (totalOrdersFoot) {
        totalOrdersFoot.textContent =
            dashboardMockDisplay.orders === null
                ? "Loading..."
                : `${dashboardMockDisplay.ordersOpen} to process · ${dashboardMockDisplay.posSales} POS sales`;
    }

}


/* =====================================================
   DASHBOARD STOCK HEALTH
   VISUAL MOCK ONLY
===================================================== */

const dashboardHealthMock = [
    {
        name: "Raw Materials",
        healthy: 4,
        total: 7,
        color: "#4a90d9"
    },
    {
        name: "Finished Goods",
        healthy: 2,
        total: 4,
        color: "#43c47a"
    }
];


function buildHealthRingSvg(percent, color) {

    const radius = 34;
    const circumference =
        2 * Math.PI * radius;

    const offset =
        circumference * (1 - percent / 100);

    return `

        <svg
            class="health-ring-svg"
            viewBox="0 0 84 84"
        >

            <circle
                cx="42"
                cy="42"
                r="${radius}"
                fill="none"
                stroke="rgba(255,255,255,0.08)"
                stroke-width="7"
            />

            <circle
                cx="42"
                cy="42"
                r="${radius}"
                fill="none"
                stroke="${color}"
                stroke-width="7"
                stroke-linecap="round"
                stroke-dasharray="${circumference}"
                stroke-dashoffset="${offset}"
                transform="rotate(-90 42 42)"
            />

            <text
                x="42"
                y="47"
                text-anchor="middle"
                class="health-ring-pct"
            >
                ${Math.round(percent)}%
            </text>

        </svg>

    `;

}


function renderStockHealthRings() {

    const container =
        document.getElementById("stockHealthRings");

    if (!container) {
        return;
    }

    container.innerHTML =
        dashboardHealthMock.map(dept => {

            const percent =
                dept.total > 0
                    ? (dept.healthy / dept.total) * 100
                    : 0;

            return `

                <div class="health-ring-card">

                    ${buildHealthRingSvg(
                        percent,
                        dept.color
                    )}

                    <div class="health-ring-name">
                        ${escapeHTML(dept.name)}
                    </div>

                    <div class="health-ring-caption">
                        ${dept.healthy} of ${dept.total} SKUs healthy
                    </div>

                </div>

            `;

        }).join("");

}


/* =====================================================
   DASHBOARD LOW-STOCK TABLE
   DISPLAY MOCK ONLY
===================================================== */

const lowStockMockData = [

    {
        name: 'Brass Forged Elbow 3/4"',
        sku: "BF-ELB-034",
        department: "Finished Goods",
        onHand: 380,
        reorderLevel: 600,
        unit: "pcs"
    },


    {
        name: "Machined Flange 160mm",
        sku: "MC-FLNG-160",
        department: "Finished Goods",
        onHand: 220,
        reorderLevel: 400,
        unit: "pcs"
    },

    {
        name: "Nickel Plating Salt",
        sku: "FS-NIPL-SALT",
        department: "Finishing Supplies",
        onHand: 96,
        reorderLevel: 120,
        unit: "kg"
    }

];


function renderLowStockProducts(products) {

    const tableBody =
        document.getElementById("lowStockTableBody");

    if (!tableBody) {
        return;
    }

    if (!products || products.length === 0) {

        tableBody.innerHTML = `

            <tr>

                <td
                    colspan="6"
                    class="dim"
                >
                    No low stock products.
                </td>

            </tr>

        `;

        return;
    }

    tableBody.innerHTML =
        products.map(product => `

            <tr>

                <td>
                    ${escapeHTML(product.name)}
                </td>

                <td class="mono">
                    ${escapeHTML(product.sku)}
                </td>

                <td class="dim">
                    ${escapeHTML(product.department)}
                </td>

                <td class="dim">
                    ${formatNumber(product.onHand)}
                    ${escapeHTML(product.unit)}
                </td>

                <td class="dim">
                    ${formatNumber(product.reorderLevel)}
                    ${escapeHTML(product.unit)}
                </td>

                <td>
                    <span class="status-pill low">
                        Low
                    </span>
                </td>

            </tr>

        `).join("");

}


/* =====================================================
   DASHBOARD RECENT MOVEMENTS
   DISPLAY MOCK ONLY
===================================================== */

const recentMovementMockData = [

    {
        ref: "MV-8841",
        product: "Brass Billet C36000",
        type: "in",
        qty: 1800,
        unit: "kg",
        department: "Raw Materials",
        handledBy: "M. Rivera",
        dateTime: "Jul 30, 07:14 AM"
    },

    {
        ref: "MV-8840",
        product: "Zinc Alloy Zamak-3",
        type: "out",
        qty: 420,
        unit: "kg",
        department: "Raw Materials",
        handledBy: "D. Okafor",
        dateTime: "Jul 30, 06:52 AM"
    }

];


function renderRecentMovements(movements) {

    const tableBody =
        document.getElementById(
            "recentMovementsTableBody"
        );

    if (!tableBody) {
        return;
    }

    if (!movements || movements.length === 0) {

        tableBody.innerHTML = `

            <tr>

                <td
                    colspan="7"
                    class="dim"
                >
                    No recent stock movements.
                </td>

            </tr>

        `;

        return;
    }

    tableBody.innerHTML =
        movements.map(movement => {

            const statusClass =
                movement.type === "in"
                    ? "in"
                    : "out";

            const typeLabel =
                movement.type === "in"
                    ? "In"
                    : "Out";

            const sign =
                movement.type === "in"
                    ? "+"
                    : "-";

            return `

                <tr>

                    <td class="mono">
                        ${escapeHTML(movement.ref)}
                    </td>

                    <td>
                        ${escapeHTML(movement.product)}
                    </td>

                    <td>
                        <span
                            class="status-pill ${statusClass}"
                        >
                            ${typeLabel}
                        </span>
                    </td>

                    <td class="dim">
                        ${sign}${formatNumber(movement.qty)}
                        ${escapeHTML(movement.unit)}
                    </td>

                    <td class="dim">
                        ${escapeHTML(movement.department)}
                    </td>

                    <td class="dim">
                        ${escapeHTML(movement.handledBy)}
                    </td>

                    <td class="dim">
                        ${escapeHTML(movement.dateTime)}
                    </td>

                </tr>

            `;

        }).join("");

}


/* =====================================================
   DASHBOARD INIT
===================================================== */

function loadDashboard() {

    renderDashboardStats();

    renderQuickActions();

    renderStockHealthRings();

    renderRecentMovements(
        recentMovementMockData
    );

}


/* =====================================================
   INVENTORY MONITORING
    DISPLAY / FILTER ONLY
===================================================== */

const inventoryMonitoringData = [

    {
        name: 'Brass Forged Elbow 3/4"',
        sku: "BF-ELB-034",
        department: "Finished Goods",
        onHand: 380,
        reorderLevel: 600,
        unit: "pcs",
        unitCost: 5.20,
        location: "FG-1 / Pallet 07"
    },


    {
        name: "Machined Flange 160mm",
        sku: "MC-FLNG-160",
        department: "Finished Goods",
        onHand: 220,
        reorderLevel: 400,
        unit: "pcs",
        unitCost: 24.75,
        location: "FG-2 / Pallet 02"
    },

    {
        name: "Nickel Plating Salt",
        sku: "FS-NIPL-SALT",
        department: "Finishing Supplies",
        onHand: 96,
        reorderLevel: 120,
        unit: "kg",
        unitCost: 41.00,
        location: "CHEM / Cabinet A"
    },

    {
        name: "Zinc Alloy Zamak-3 Ingot",
        sku: "RM-ZAM-3",
        department: "Raw Materials",
        onHand: 1180,
        reorderLevel: 1500,
        unit: "kg",
        unitCost: 3.15,
        location: "RM-A / Rack 04"
    },

    {
        name: "Brass Billet C36000 · 25mm",
        sku: "RM-BRS-C360",
        department: "Raw Materials",
        onHand: 8420,
        reorderLevel: 3000,
        unit: "kg",
        unitCost: 6.42,
        location: "RM-A / Rack 01"
    }

];


function getStockStatus(item) {

    if (item.onHand <= item.reorderLevel) {
        return "low";
    }

    if (item.onHand <= item.reorderLevel * 1.2) {
        return "watch";
    }

    return "ok";

}


function getStockStatusLabel(status) {

    if (status === "low") {
        return "Low";
    }

    if (status === "watch") {
        return "Watch";
    }

    return "OK";

}


function renderInventoryMonitoringStats(items) {

    const total =
        items.length;

    const below =
        items.filter(
            item => getStockStatus(item) === "low"
        ).length;

    const near =
        items.filter(
            item => getStockStatus(item) === "watch"
        ).length;

    const healthy =
        items.filter(
            item => getStockStatus(item) === "ok"
        ).length;

    const departmentCount =
        new Set(
            items.map(item => item.department)
        ).size;


    const setText = (id, value) => {

        const element =
            document.getElementById(id);

        if (element) {
            element.textContent = value;
        }

    };


    setText("invTotalSkus", total);

    setText(
        "invTotalSkusFoot",
        `${departmentCount} departments`
    );

    setText("invBelowReorder", below);

    setText(
        "invBelowReorderFoot",
        "Needs restock"
    );

    setText("invNearReorder", near);

    setText(
        "invNearReorderFoot",
        "Watch closely"
    );

    setText("invHealthyStock", healthy);

    setText(
        "invHealthyStockFoot",
        "Sufficient buffer"
    );

}


function renderStockLevelsTable(items) {

    const tableBody =
        document.getElementById(
            "stockLevelsTableBody"
        );

    if (!tableBody) {
        return;
    }

    if (!items || items.length === 0) {

        tableBody.innerHTML = `

            <tr class="no-results-row">

                <td colspan="8">
                    No products match your filters.
                </td>

            </tr>

        `;

        return;
    }

    tableBody.innerHTML =
        items.map(item => {

            const status =
                getStockStatus(item);

            const fillPercent =
                Math.min(
                    (item.onHand /
                        item.reorderLevel) * 100,
                    100
                );

            return `

                <tr data-sku="${escapeHTML(item.sku)}" title="Double-click to record stock in / out">

                    <td>
                        ${escapeHTML(item.name)}
                    </td>

                    <td class="mono">
                        ${escapeHTML(item.sku)}
                    </td>

                    <td class="dim">
                        ${escapeHTML(item.department)}
                    </td>

                    <td class="stock-level-cell">

                        <div class="stock-level-text">
                            ${formatNumber(item.onHand)}
                            /
                            ${formatNumber(item.reorderLevel)}
                            ${escapeHTML(item.unit)}
                        </div>

                        <div class="stock-bar-track">

                            <div
                                class="stock-bar-fill ${status}"
                                style="width:${fillPercent}%"
                            ></div>

                        </div>

                    </td>

                    <td class="dim">
                        ${formatNumber(item.reorderLevel)}
                        ${escapeHTML(item.unit)}
                    </td>

                    <td class="dim">
                        ${formatCurrency(item.unitCost)}
                    </td>

                    <td class="dim">
                        ${escapeHTML(item.location)}
                    </td>

                    <td>

                        <span class="status-pill ${status}">
                            ${getStockStatusLabel(status)}
                        </span>

                    </td>

                </tr>

            `;

        }).join("");

}


function applyInventoryFilters() {

    const searchInput =
        document.getElementById("invSearch");

    const deptFilter =
        document.getElementById("invDeptFilter");

    const statusFilter =
        document.getElementById("invStatusFilter");

    const panelSub =
        document.getElementById("invPanelSub");


    const searchTerm =
        searchInput
            ? searchInput.value
                .trim()
                .toLowerCase()
            : "";

    const department =
        deptFilter
            ? deptFilter.value
            : "all";

    const status =
        statusFilter
            ? statusFilter.value
            : "all";


    const filtered =
        inventoryMonitoringData.filter(item => {

            const matchesSearch =
                !searchTerm ||
                item.name
                    .toLowerCase()
                    .includes(searchTerm) ||
                item.sku
                    .toLowerCase()
                    .includes(searchTerm);

            const matchesDepartment =
                department === "all" ||
                item.department === department;

            const matchesStatus =
                status === "all" ||
                getStockStatus(item) === status;

            return (
                matchesSearch &&
                matchesDepartment &&
                matchesStatus
            );

        });


    if (panelSub) {

        panelSub.textContent =
            `${filtered.length} SKU${
                filtered.length === 1 ? "" : "s"
            } · Sorted by stock status`;

    }

    renderStockLevelsTable(filtered);

}


function initInventoryMonitoring() {

    renderInventoryMonitoringStats(
        inventoryMonitoringData
    );

    applyInventoryFilters();


    const searchInput =
        document.getElementById("invSearch");

    const deptFilter =
        document.getElementById("invDeptFilter");

    const statusFilter =
        document.getElementById("invStatusFilter");


    if (searchInput) {
        searchInput.addEventListener(
            "input",
            applyInventoryFilters
        );
    }

    if (deptFilter) {
        deptFilter.addEventListener(
            "change",
            applyInventoryFilters
        );
    }

    if (statusFilter) {
        statusFilter.addEventListener(
            "change",
            applyInventoryFilters
        );
    }

}


/* =====================================================
   STOCK IN / OUT
===================================================== */

function updateMovementStockSummary() {

    const quantityInput =
        document.getElementById(
            "movementQuantity"
        );

    const currentEl =
        document.getElementById(
            "summaryCurrentStock"
        );

    const afterEl =
        document.getElementById(
            "summaryAfterStock"
        );


    if (currentEl) {
        currentEl.textContent = "—";
    }

    if (afterEl) {
        afterEl.textContent = "—";
    }

}


function initMovementForm() {

    const form =
        document.getElementById(
            "movementForm"
        );

    const quantityInput =
        document.getElementById(
            "movementQuantity"
        );

    const toggleGroup =
        document.getElementById(
            "movementTypeToggle"
        );

    const errorEl =
        document.getElementById(
            "movementFormError"
        );


    if (!form) {
        return;
    }


    if (quantityInput) {

        quantityInput.addEventListener(
            "input",
            updateMovementStockSummary
        );

    }


    if (toggleGroup) {

        toggleGroup
            .querySelectorAll(".seg-btn")
            .forEach(button => {

                button.addEventListener(
                    "click",
                    () => {

                        toggleGroup
                            .querySelectorAll(".seg-btn")
                            .forEach(btn => {
                                btn.classList.remove(
                                    "active"
                                );
                            });

                        button.classList.add(
                            "active"
                        );

                        updateMovementStockSummary();

                    }
                );

            });

    }


    form.addEventListener(
        "submit",
        event => {

            event.preventDefault();

            if (errorEl) {
                errorEl.classList.remove("show");
            }

            const product =
                document.getElementById(
                    "movementProduct"
                );

            const quantity =
                Number(
                    quantityInput
                        ? quantityInput.value
                        : 0
                );


            if (
                !product ||
                !product.value ||
                !quantity ||
                quantity <= 0
            ) {

                if (errorEl) {
                    errorEl.classList.add(
                        "show"
                    );
                }

                return;
            }



            alert(
                "Stock movement form submitted. " +
                "hehe"
            );

        }
    );

}


function initStockInOut() {

    initMovementForm();


    const logSearch =
        document.getElementById("logSearch");

    const logTypeFilter =
        document.getElementById("logTypeFilter");


    if (logSearch) {

        logSearch.addEventListener(
            "input",
            () => {


            }
        );

    }


    if (logTypeFilter) {

        logTypeFilter.addEventListener(
            "change",
            () => {


            }
        );

    }

}


/* =====================================================
   PRODUCTS
   DISPLAY / SEARCH ONLY
===================================================== */

const productCatalogData = [

    {
        sku: "CS-HRC-3.0-1250",
            department: "Raw Materials",
            reorderLevel: 300000,
        name: "Hot Rolled Coil 3.0mm × 1250",
        grade: "S275JR",
        form: "Coil",
        category: "Carbon Steel",
        status: "ok",
        available: 394000,
        unit: "kg",
        costUnit: "tonne",
        stdCost: 0.72,
        listPrice: 0.94,
        margin: 23.4,
        primarySource: "Rhein Stahl GmbH"
    },

    {
        sku: "SS-316L-SHT-2.0",
            department: "Raw Materials",
            reorderLevel: 60000,
        name: "Stainless Sheet 2.0mm 2B",
        grade: "316L",
        form: "Sheet",
        category: "Stainless Steel",
        status: "low",
        available: 53200,
        unit: "kg",
        costUnit: "kg",
        stdCost: 3.85,
        listPrice: 4.98,
        margin: 22.7,
        primarySource: "Kanto Alloy Works"
    },

    {
        sku: "AL-6061-BAR-40",
            department: "Raw Materials",
            reorderLevel: 80000,
        name: "Aluminium Round Bar 040",
        grade: "6061-T6",
        form: "Bar",
        category: "Aluminium",
        status: "ok",
        available: 115500,
        unit: "kg",
        costUnit: "kg",
        stdCost: 2.41,
        listPrice: 3.24,
        margin: 25.6,
        primarySource: "Northline Metals Ltd."
    },

    {
        sku: "CS-BIL-150SQ",
            department: "Raw Materials",
            reorderLevel: 40000,
        name: "Billet 150mm Square",
        grade: "C45",
        form: "Billet",
        category: "Carbon Steel",
        status: "low",
        available: 32000,
        unit: "kg",
        costUnit: "tonne",
        stdCost: 0.68,
        listPrice: 0.86,
        margin: 20.9,
        primarySource: "Gulf Billet Trading"
    },

    {
        sku: "CU-C11000-TUB-25",
            department: "Raw Materials",
            reorderLevel: 12000,
        name: "Copper Tube Ø25 × 1.5",
        grade: "C11000",
        form: "Tube",
        category: "Copper Alloy",
        status: "low",
        available: 10550,
        unit: "kg",
        costUnit: "kg",
        stdCost: 8.62,
        listPrice: 11.40,
        margin: 24.4,
        primarySource: "Andes Copper Coop"
    },

    {
        sku: "CS-PLT-12-2000",
            department: "Raw Materials",
            reorderLevel: 500000,
        name: "Structural Plate 12mm × 2000",
        grade: "S355J2",
        form: "Plate",
        category: "Carbon Steel",
        status: "watch",
        available: 563500,
        unit: "kg",
        costUnit: "tonne",
        stdCost: 0.79,
        listPrice: 1.02,
        margin: 22.5,
        primarySource: "Rhein Stahl GmbH"
    },

    {
        sku: "SS-304-COIL-1.5",
            department: "Raw Materials",
            reorderLevel: 70000,
        name: "Stainless Coil 1.5mm",
        grade: "304",
        form: "Coil",
        category: "Stainless Steel",
        status: "low",
        available: 62700,
        unit: "kg",
        costUnit: "kg",
        stdCost: 3.12,
        listPrice: 4.05,
        margin: 23.0,
        primarySource: "Kanto Alloy Works"
    },

    {
        sku: "AL-5052-SHT-3.0",
            department: "Raw Materials",
            reorderLevel: 5000,
        name: "Aluminium Sheet 3.0mm",
        grade: "5052-H32",
        form: "Sheet",
        category: "Aluminium",
        status: "low",
        available: 2200,
        unit: "kg",
        costUnit: "kg",
        stdCost: 2.68,
        listPrice: 3.61,
        margin: 25.8,
        primarySource: "Northline Metals Ltd."
    }

];


let activeCatalogCategory =
    "All categories";


function getCatalogCategories() {

    const categories =
        ["All categories"];

    productCatalogData.forEach(
        product => {

            if (
                !categories.includes(
                    product.category
                )
            ) {

                categories.push(
                    product.category
                );

            }

        }
    );

    return categories;

}


function renderCategoryPills() {

    const container =
        document.getElementById(
            "categoryPills"
        );

    if (!container) {
        return;
    }

    container.innerHTML = "";

    getCatalogCategories()
        .forEach(category => {

            const count =
                category === "All categories"
                    ? productCatalogData.length
                    : productCatalogData.filter(
                        item =>
                            item.category === category
                    ).length;

            const button =
                document.createElement("button");

            button.type = "button";

            button.className =
                "pill-btn" +
                (
                    category === activeCatalogCategory
                        ? " active"
                        : ""
                );

            button.innerHTML = `

                ${escapeHTML(category)}

                <span class="count">
                    ${count}
                </span>

            `;

            button.addEventListener(
                "click",
                () => {

                    activeCatalogCategory =
                        category;

                    container
                        .querySelectorAll(
                            ".pill-btn"
                        )
                        .forEach(
                            pill =>
                                pill.classList.remove(
                                    "active"
                                )
                        );

                    button.classList.add(
                        "active"
                    );

                    applyCatalogFilters();

                }
            );

            container.appendChild(button);

        });

}


function renderProductTable(items) {

    const tableBody =
        document.getElementById(
            "productTableBody"
        );

    if (!tableBody) {
        return;
    }

    if (!items || items.length === 0) {

        tableBody.innerHTML = `

            <tr class="no-results-row">

                <td colspan="11">
                    No products match your search or category.
                </td>

            </tr>

        `;

        return;

    }

    tableBody.innerHTML =
        items.map(item => {

            const costLabel =
                "/" + (item.costUnit || item.unit || "kg");

            const metaLine =
                [item.grade, item.form]
                    .filter(Boolean)
                    .join(" · ");

            return `

                <tr>

                    <td>

                        <div class="supplier-name">
                            ${escapeHTML(item.name)}
                        </div>

                        ${metaLine
                            ? `<div class="supplier-meta">${escapeHTML(metaLine)}</div>`
                            : ""}

                    </td>

                    <td class="mono">
                        ${escapeHTML(item.sku)}
                    </td>

                    <td class="dim">
                        ${escapeHTML(item.category)}
                    </td>

                    <td class="dim">
                        ${escapeHTML(item.department || "\u2014")}
                    </td>

                    <td class="dim">
                        ${formatNumber(item.available)}
                        ${escapeHTML(item.unit)}
                    </td>

                    <td class="dim">
                        ₱${item.stdCost.toFixed(2)}
                        ${costLabel}
                    </td>

                    <td class="dim">
                        ${item.department === "Finished Goods"
                            ? (item.listPrice > 0 ? "₱" + item.listPrice.toFixed(2) : `<span class="prod-supplier warn" title="Finished Goods need a selling price">No price yet</span>`)
                            : `<span title="Not sold: only Finished Goods have a selling price">&mdash;</span>`}
                    </td>

                    <td>
                        ${item.department === "Finished Goods" && item.listPrice > 0
                            ? `<span class="margin-value">${item.margin.toFixed(1)}%</span>`
                            : `<span class="dim">&mdash;</span>`}
                    </td>

                    <td class="dim">
                        ${renderProductSuppliers(item)}
                    </td>

                    <td>
                        <span class="status-pill ${item.status}">
                            ${getStockStatusLabel(item.status)}
                        </span>
                    </td>

                        <td>

                            <button
                                type="button"
                                class="btn-secondary btn-sm product-edit-btn"
                                data-sku="${escapeHTML(item.sku)}"
                            >
                                Edit
                            </button>

                        </td>

                </tr>

            `;

        }).join("");


        tableBody
            .querySelectorAll(".product-edit-btn")
            .forEach(button => {

                button.addEventListener(
                    "click",
                    () => {

                        openNewProductModal(
                            button.dataset.sku
                        );

                    }
                );

            });

}


// Suppliers shown in the Products table: every supplier linked to the product, primary first.
function renderProductSuppliers(item) {

    const linked =
        Array.isArray(item.suppliers)
            ? item.suppliers
            : [];

    // older / sample records only carry a single supplier name
    if (!linked.length) {

        if (item.primarySource)
            return `<span class="prod-supplier">${escapeHTML(item.primarySource)}</span>`;

        // Raw Materials / Finishing Supplies are bought in, so a missing supplier is flagged.
        // Finished Goods are made by the company itself: no supplier, the source is in-house production.
        return (item.department === "Raw Materials" || item.department === "Finishing Supplies")
            ? `<span class="prod-supplier warn" title="Link a supplier in Supplier Management">No supplier yet</span>`
            : `<span class="prod-supplier inhouse" title="Made by the company, so no supplier is needed">In-house production</span>`;

    }

    const showPrimaryTag = linked.length > 1;

    return `<div class="prod-suppliers">${
        linked.map(s => {

            const archived = s.status === "archived";

            return `<span class="prod-supplier${archived ? " archived" : ""}">`
                + escapeHTML(s.name)
                + (s.primary && showPrimaryTag
                    ? ` <em class="prod-tag">Primary</em>`
                    : "")
                + (archived
                    ? ` <em class="prod-tag muted">Archived</em>`
                    : "")
                + `</span>`;

        }).join("")
    }</div>`;

}

function applyCatalogFilters() {

    const searchInput =
        document.getElementById(
            "catalogSearch"
        );

    const searchTerm =
        searchInput
            ? searchInput.value
                .trim()
                .toLowerCase()
            : "";


    const filtered =
        productCatalogData.filter(item => {

            const categoryMatch =
                activeCatalogCategory ===
                    "All categories" ||
                item.category ===
                    activeCatalogCategory;

            const searchMatch =
                !searchTerm ||
                item.name
                    .toLowerCase()
                    .includes(searchTerm) ||
                item.sku
                    .toLowerCase()
                    .includes(searchTerm) ||
                (item.grade || "")
                    .toLowerCase()
                    .includes(searchTerm) ||
                (Array.isArray(item.suppliers) && item.suppliers.length
                    ? item.suppliers
                    : [{ name: item.primarySource || "" }])
                    .some(sp =>
                        (sp.name || "")
                            .toLowerCase()
                            .includes(searchTerm)
                    );

            return (
                categoryMatch &&
                searchMatch
            );

        });


    const sub =
        document.getElementById(
            "productListSub"
        );

    if (sub) {

        sub.textContent =
            `${filtered.length} product${
                filtered.length === 1
                    ? ""
                    : "s"
            }`;

    }

    renderProductTable(filtered);

}


function initProductCatalog() {

    initNewProductModal();

    renderCategoryPills();

    applyCatalogFilters();


    const searchInput =
        document.getElementById(
            "catalogSearch"
        );

    if (searchInput) {

        searchInput.addEventListener(
            "input",
            applyCatalogFilters
        );

    }


    const newProductBtn =
        document.getElementById(
            "newProductBtn"
        );

    if (newProductBtn) {

        newProductBtn.addEventListener(
            "click",
            () => {

                openNewProductModal();

            }
        );

    }

}


/* =====================================================
   NEW PRODUCT MODAL
   fisplay
===================================================== */

let editingProductSku = null;


function openNewProductModal(
    productSku = null
) {

    const overlay =
        document.getElementById("newProductModalOverlay");

    if (!overlay) {
        return;
    }

    editingProductSku =
        productSku || null;

    const title =
        document.getElementById("newProductModalTitle");

    const saveButton =
        document.getElementById("newProductSaveBtn");

    const setValue = (id, value) => {

        const el =
            document.getElementById(id);

        if (el) {
            el.value = value;
        }

    };


    if (editingProductSku) {

        const product =
            productCatalogData.find(
                item => item.sku === editingProductSku
            );

        if (title) {
            title.textContent = "Edit product";
        }

        if (saveButton) {
            saveButton.textContent = "Save Changes";
        }

        if (product) {

            setValue("npSku", product.sku);
            setValue("npName", product.name);
            setValue("npDept", product.department || "Raw Materials");
            setValue("npCategory", product.category);
            setValue("npUnit", product.unit);
            setValue("npUnitCost", product.stdCost);
            if (window.MoneyInput) MoneyInput.set(document.getElementById("npUnitCost"), product.stdCost);
            setValue("npOnHand", product.available);
            setValue("npReorder", product.reorderLevel ?? "");
            setValue("npSource", product.primarySource);

        }

    } else {

        if (title) {
            title.textContent = "New product";
        }

        if (saveButton) {
            saveButton.textContent = "Save Product";
        }

    }

    overlay.classList.add("open");

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    const sku =
        document.getElementById("npSku");

    if (sku) {
        sku.focus();
    }

}


function closeNewProductModal() {

    const overlay =
        document.getElementById("newProductModalOverlay");

    if (!overlay) {
        return;
    }

    overlay.classList.remove("open");

    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";

    const form =
        document.getElementById("newProductForm");

    if (form) {
        form.reset();
    }

    const error =
        document.getElementById("newProductFormError");

    if (error) {
        error.classList.remove("show");
    }

    editingProductSku = null;

}


function initNewProductModal() {

    const overlay =
        document.getElementById("newProductModalOverlay");

    ["newProductCloseBtn", "newProductCancelBtn"]
        .forEach(id => {

            const button =
                document.getElementById(id);

            if (button) {
                button.addEventListener(
                    "click",
                    closeNewProductModal
                );
            }

        });

    if (overlay) {

        overlay.addEventListener("click", event => {

            if (event.target === overlay) {
                closeNewProductModal();
            }

        });

    }

    document.addEventListener("keydown", event => {

        if (
            event.key === "Escape" &&
            overlay &&
            overlay.classList.contains("open")
        ) {
            closeNewProductModal();
        }

    });


    const form =
        document.getElementById("newProductForm");

    const error =
        document.getElementById("newProductFormError");

    if (form) {

        form.addEventListener("submit", event => {

            event.preventDefault();

            const textIds = [
                "npSku",
                "npName",
                "npCategory",
                "npUnit"
            ];

            const numberIds = [
                "npUnitCost",
                "npOnHand",
                "npReorder"
            ];

            const textsValid =
                textIds.every(id => {
                    const el = document.getElementById(id);
                    return el && el.value.trim();
                });

            const numbersValid =
                numberIds.every(id => {
                    const el = document.getElementById(id);
                    return (
                        el &&
                        el.value !== "" &&
                        Number(String(el.value).replace(/,/g, "")) >= 0
                    );
                });

            if (!textsValid || !numbersValid) {

                if (error) {
                    error.classList.add("show");
                }

                return;
            }

            if (error) {
                error.classList.remove("show");
            }
            alert(
                editingProductSku
                    ? "Product changes hehe"
                    : "New product information hehe"
            );

            closeNewProductModal();

        });

    }

}


/* =====================================================
   SUPPLIERS
   temporary info
===================================================== */

const supplierData = [

    {
        id: "andes-copper",
        name: "Andes Copper Coop",
        initials: "AC",
        status: "active",
        location: "Warehouse C",
        contact: "Marisol Tan · +63 917 220 3391",
        supplies: "Brass Billet C36000, Copper Tube"
    },

    {
        id: "northline-metals",
        name: "Northline Metals Ltd.",
        initials: "NM",
        status: "active",
        location: "Warehouse B",
        contact: "R. Guevarra · +63 918 445 2210",
        supplies: "Zinc Alloy Zamak-3, Aluminium ADC-12"
    },

    {
        id: "rhein-stahl",
        name: "Rhein Stahl GmbH",
        initials: "RS",
        status: "active",
        location: "Mill Yard A",
        contact: "orders@rheinstahl.de",
        supplies: "Hot Rolled Coil, Structural Plate"
    },

    {
        id: "kanto-alloy",
        name: "Kanto Alloy Works",
        initials: "KA",
        status: "active",
        location: "Warehouse B",
        contact: "H. Suzuki · +81 3 5555 0192",
        supplies: "Stainless Sheet 2.0mm"
    },

    {
        id: "gulf-billet",
        name: "Gulf Billet Trading",
        initials: "GB",
        status: "active",
        location: "Mill Yard A",
        contact: "A. Al-Farsi · +971 4 220 8890",
        supplies: "Billet 150mm Square"
    },

    {
        id: "metro-chem",
        name: "Metro Chem Supplies",
        initials: "MC",
        status: "archived",
        location: "Storeroom",
        contact: "F. Villanueva · +63 927 110 4482",
        supplies: "Nickel Plating Salt"
    }

];


let activeWarehouseFilter =
    "All warehouses";

let editingSupplierId = null;


function getSupplierStatusLabel(status) {

    return status === "archived"
        ? "Archived"
        : "Active";

}


function getSupplierWarehouses() {

    const warehouses =
        ["All warehouses"];

    supplierData.forEach(
        supplier => {

            if (
                !warehouses.includes(
                    supplier.location
                )
            ) {

                warehouses.push(
                    supplier.location
                );

            }

        }
    );

    return warehouses;

}


function renderWarehousePills() {

    const container =
        document.getElementById(
            "warehousePills"
        );

    if (!container) {
        return;
    }

    container.innerHTML = "";


    getSupplierWarehouses()
        .forEach(warehouse => {

            const count =
                warehouse === "All warehouses"
                    ? supplierData.length
                    : supplierData.filter(
                        supplier =>
                            supplier.location === warehouse
                    ).length;

            const button =
                document.createElement("button");

            button.type = "button";

            button.className =
                "pill-btn" +
                (
                    warehouse ===
                        activeWarehouseFilter
                        ? " active"
                        : ""
                );

            button.innerHTML = `

                ${escapeHTML(warehouse)}

                <span class="count">
                    ${count}
                </span>

            `;

            button.addEventListener(
                "click",
                () => {

                    activeWarehouseFilter =
                        warehouse;

                    container
                        .querySelectorAll(
                            ".pill-btn"
                        )
                        .forEach(
                            pill =>
                                pill.classList.remove(
                                    "active"
                                )
                        );

                    button.classList.add(
                        "active"
                    );

                    applySupplierFilters();

                }
            );

            container.appendChild(button);

        });

}


function renderSupplierTable(items) {

    const tableBody =
        document.getElementById(
            "supplierTableBody"
        );

    if (!tableBody) {
        return;
    }

    if (!items || items.length === 0) {

        tableBody.innerHTML = `

            <tr class="no-results-row">

                <td colspan="6">
                    No suppliers match your search.
                </td>

            </tr>

        `;

        return;

    }

    tableBody.innerHTML =
        items.map(supplier => `

            <tr>

                <td>

                    <div class="supplier-row-name">

                        <div class="supplier-avatar">
                            ${escapeHTML(
                                supplier.initials
                            )}
                        </div>

                        ${escapeHTML(
                            supplier.name
                        )}

                    </div>

                </td>

                <td class="dim">
                    ${escapeHTML(
                        supplier.fullAddress || supplier.location
                    )}
                </td>

                <td class="dim">
                    ${escapeHTML(
                        supplier.contact
                    )}
                </td>

                <td class="dim">
                    ${escapeHTML(
                        supplier.supplies
                    )}
                </td>

                <td>

                    <span
                        class="status-pill ${supplier.status}"
                    >
                        ${getSupplierStatusLabel(
                            supplier.status
                        )}
                    </span>

                </td>

                <td>

                    <button
                        type="button"
                        class="btn-secondary btn-sm supplier-edit-btn"
                        data-supplier-id="${escapeHTML(
                            supplier.id
                        )}"
                    >
                        Edit
                    </button>

                </td>

            </tr>

        `).join("");


    tableBody
        .querySelectorAll(
            ".supplier-edit-btn"
        )
        .forEach(button => {

            button.addEventListener(
                "click",
                () => {

                    openNewSupplierModal(
                        button.dataset.supplierId
                    );

                }
            );

        });

}


function applySupplierFilters() {

    const searchInput =
        document.getElementById(
            "supplierSearch"
        );

    const countEl =
        document.getElementById(
            "supplierCount"
        );


    const searchTerm =
        searchInput
            ? searchInput.value
                .trim()
                .toLowerCase()
            : "";


    const filtered =
        supplierData.filter(
            supplier => {

                const warehouseMatch =
                    activeWarehouseFilter ===
                        "All warehouses" ||
                    supplier.location ===
                        activeWarehouseFilter;

                const searchMatch =
                    !searchTerm ||
                    supplier.name
                        .toLowerCase()
                        .includes(searchTerm) ||
                    (supplier.fullAddress || supplier.location)
                        .toLowerCase()
                        .includes(searchTerm) ||
                    supplier.contact
                        .toLowerCase()
                        .includes(searchTerm) ||
                    supplier.supplies
                        .toLowerCase()
                        .includes(searchTerm);

                return (
                    warehouseMatch &&
                    searchMatch
                );

            }
        );


    if (countEl) {

        countEl.textContent =
            `${filtered.length} supplier${
                filtered.length === 1
                    ? ""
                    : "s"
            }`;

    }

    renderSupplierTable(filtered);

}


function initSuppliers() {

    renderWarehousePills();

    applySupplierFilters();


    const searchInput =
        document.getElementById(
            "supplierSearch"
        );

    if (searchInput) {

        searchInput.addEventListener(
            "input",
            applySupplierFilters
        );

    }


    const onboardButton =
        document.getElementById(
            "onboardSupplierBtn"
        );

    if (onboardButton) {

        onboardButton.addEventListener(
            "click",
            () => openNewSupplierModal()
        );

    }

}


/* =====================================================
   SUPPLIER MODAL
===================================================== */

function openNewSupplierModal(
    supplierId = null
) {

    const overlay =
        document.getElementById(
            "newSupplierModalOverlay"
        );

    if (!overlay) {
        return;
    }

    editingSupplierId =
        supplierId || null;


    const title =
        document.getElementById(
            "newSupplierModalTitle"
        );

    const saveButton =
        document.getElementById(
            "newSupplierSaveBtn"
        );


    if (editingSupplierId) {

        const supplier =
            supplierData.find(
                item =>
                    item.id ===
                    editingSupplierId
            );

        if (title) {
            title.textContent =
                "Edit Supplier";
        }

        if (saveButton) {
            saveButton.textContent =
                "Save Changes";
        }


        if (supplier) {

            const name =
                document.getElementById(
                    "newSupplierName"
                );

            const contact =
                document.getElementById(
                    "newSupplierContact"
                );

            const products =
                document.getElementById(
                    "newSupplierProducts"
                );

            const location =
                document.getElementById(
                    "newSupplierLocation"
                );


            if (name) {
                name.value =
                    supplier.name;
            }

            if (contact) {
                contact.value =
                    supplier.contact;
            }

            if (products) {
                products.value =
                    supplier.supplies;
            }

            if (location) {
                location.value =
                    supplier.location;
            }

        }

    } else {

        if (title) {
            title.textContent =
                "New Supplier";
        }

        if (saveButton) {
            saveButton.textContent =
                "Save Supplier";
        }

    }


    overlay.classList.add("open");

    document.body.style.overflow =
        "hidden";

    document.documentElement.style.overflow =
        "hidden";

}


function closeNewSupplierModal() {

    const overlay =
        document.getElementById(
            "newSupplierModalOverlay"
        );

    if (!overlay) {
        return;
    }

    overlay.classList.remove("open");

    document.body.style.overflow =
        "";

    document.documentElement.style.overflow =
        "";


    const form =
        document.getElementById(
            "newSupplierForm"
        );

    if (form) {
        form.reset();
    }


    const error =
        document.getElementById(
            "newSupplierFormError"
        );

    if (error) {
        error.classList.remove(
            "show"
        );
    }

    editingSupplierId = null;

}


function initNewSupplierModal() {

    const overlay =
        document.getElementById(
            "newSupplierModalOverlay"
        );

    const closeButton =
        document.getElementById(
            "newSupplierCloseBtn"
        );

    const cancelButton =
        document.getElementById(
            "newSupplierCancelBtn"
        );

    const form =
        document.getElementById(
            "newSupplierForm"
        );

    const error =
        document.getElementById(
            "newSupplierFormError"
        );


    if (closeButton) {

        closeButton.addEventListener(
            "click",
            closeNewSupplierModal
        );

    }

    if (cancelButton) {

        cancelButton.addEventListener(
            "click",
            closeNewSupplierModal
        );

    }


    if (overlay) {

        overlay.addEventListener(
            "click",
            event => {

                if (
                    event.target === overlay
                ) {

                    closeNewSupplierModal();

                }

            }
        );

    }


    document.addEventListener(
        "keydown",
        event => {

            if (
                event.key === "Escape" &&
                overlay &&
                overlay.classList.contains(
                    "open"
                )
            ) {

                closeNewSupplierModal();

            }

        }
    );


    if (form) {

        form.addEventListener(
            "submit",
            event => {

                event.preventDefault();


                const name =
                    document.getElementById(
                        "newSupplierName"
                    );

                const contact =
                    document.getElementById(
                        "newSupplierContact"
                    );

                const products =
                    document.getElementById(
                        "newSupplierProducts"
                    );

                const location =
                    document.getElementById(
                        "newSupplierLocation"
                    );


                const valid =
                    name &&
                    contact &&
                    products &&
                    location &&
                    name.value.trim() &&
                    contact.value.trim() &&
                    products.value.trim() &&
                    location.value.trim();


                if (!valid) {

                    if (error) {
                        error.classList.add(
                            "show"
                        );
                    }

                    return;

                }


                if (error) {
                    error.classList.remove(
                        "show"
                    );
                }

                alert(
                    editingSupplierId
                        ? "Supplier changes hehe."
                        : "New supplier information hehe"
                );

                closeNewSupplierModal();

            }
        );

    }

}


/* =====================================================
   REPORTS
===================================================== */

let reportPeriodType =
    "daily";

let reportAnchorDate =
    "2026-08-09";

let reportCustomFrom =
    "2026-08-03";

let reportCustomTo =
    "2026-08-09";


const REPORT_DEPARTMENT_COLORS = {

    "Raw Materials": "#4a90d9",

    "Finished Goods": "#43c47a",

    "Finishing Supplies": "#e35b9e"

};


const MONTH_NAMES = [

    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"

];


function parseDateParts(dateString) {

    const [
        year,
        month,
        day
    ] =
        dateString
            .split("-")
            .map(Number);

    return {
        year,
        month,
        day
    };

}


function addDaysToDateString(
    dateString,
    days
) {

    const date =
        new Date(
            `${dateString}T00:00:00Z`
        );

    date.setUTCDate(
        date.getUTCDate() + days
    );

    return date
        .toISOString()
        .split("T")[0];

}


function formatDisplayDate(
    dateString
) {

    const {
        year,
        month,
        day
    } =
        parseDateParts(dateString);

    return `${MONTH_NAMES[month - 1]} ${String(day).padStart(2, "0")}, ${year}`;

}


function renderReportPeriodPanel() {

    const dateNavRow =
        document.getElementById(
            "dateNavRow"
        );

    const customRangeRow =
        document.getElementById(
            "customRangeRow"
        );

    const showingPill =
        document.getElementById(
            "dateShowingPill"
        );


    const isCustom =
        reportPeriodType ===
        "custom";


    if (dateNavRow) {

        dateNavRow.style.display =
            isCustom
                ? "none"
                : "flex";

    }


    if (customRangeRow) {

        customRangeRow.style.display =
            isCustom
                ? "flex"
                : "none";

    }


    if (showingPill && !isCustom) {

        showingPill.textContent =
            `Showing ${formatDisplayDate(
                reportAnchorDate
            )}`;

    }

}


function initReports() {

    renderReportPeriodPanel();


    const periodToggle =
        document.getElementById(
            "reportPeriodToggle"
        );


    if (periodToggle) {

        periodToggle
            .querySelectorAll(
                ".period-btn"
            )
            .forEach(button => {

                button.addEventListener(
                    "click",
                    () => {

                        reportPeriodType =
                            button.dataset.period;

                        periodToggle
                            .querySelectorAll(
                                ".period-btn"
                            )
                            .forEach(btn => {
                                btn.classList.remove(
                                    "active"
                                );
                            });

                        button.classList.add(
                            "active"
                        );

                        renderReportPeriodPanel();

                    }
                );

            });

    }


    const prevButton =
        document.getElementById(
            "datePrevBtn"
        );

    if (prevButton) {

        prevButton.addEventListener(
            "click",
            () => {

                reportAnchorDate =
                    addDaysToDateString(
                        reportAnchorDate,
                        -1
                    );

                renderReportPeriodPanel();

            }
        );

    }


    const nextButton =
        document.getElementById(
            "dateNextBtn"
        );

    if (nextButton) {

        nextButton.addEventListener(
            "click",
            () => {

                reportAnchorDate =
                    addDaysToDateString(
                        reportAnchorDate,
                        1
                    );

                renderReportPeriodPanel();

            }
        );

    }


    const jumpLink =
        document.getElementById(
            "jumpLatestLink"
        );

    if (jumpLink) {

        jumpLink.addEventListener(
            "click",
            event => {

                event.preventDefault();

                reportAnchorDate =
                    "2026-08-09";

                renderReportPeriodPanel();

            }
        );

    }


    const printButton =
        document.getElementById(
            "printReportBtn"
        );

    if (printButton) {

        printButton.addEventListener(
            "click",
            () => {

            }
        );

    }


    const exportButton =
        document.getElementById(
            "exportCsvBtn"
        );

    if (exportButton) {

        exportButton.addEventListener(
            "click",
            () => {

            }
        );

    }

}


/* =====================================================
   USER MENU
===================================================== */

function initUserMenu() {

    const wrap =
        document.getElementById(
            "userMenuWrap"
        );

    const chipButton =
        document.getElementById(
            "userChipBtn"
        );

    const dropdown =
        document.getElementById(
            "userDropdown"
        );


    if (
        !wrap ||
        !chipButton ||
        !dropdown
    ) {
        return;
    }


    chipButton.addEventListener(
        "click",
        event => {

            event.stopPropagation();

            dropdown.classList.toggle(
                "open"
            );

        }
    );


    document.addEventListener(
        "click",
        event => {

            if (
                !wrap.contains(
                    event.target
                )
            ) {

                dropdown.classList.remove(
                    "open"
                );

            }

        }
    );


    document.addEventListener(
        "keydown",
        event => {

            if (event.key === "Escape") {

                dropdown.classList.remove(
                    "open"
                );

            }

        }
    );


    const profileButton =
        document.getElementById(
            "myProfileBtn"
        );

    if (profileButton) {

        profileButton.addEventListener(
            "click",
            () => {

                openAccountModal(
                    "profile"
                );

                dropdown.classList.remove(
                    "open"
                );

            }
        );

    }


    const passwordButton =
        document.getElementById(
            "changePasswordBtn"
        );

    if (passwordButton) {

        passwordButton.addEventListener(
            "click",
            () => {

                openAccountModal(
                    "password"
                );

                dropdown.classList.remove(
                    "open"
                );

            }
        );

    }


    const logoutButton =
        document.getElementById(
            "logoutBtn"
        );

    if (logoutButton) {

        logoutButton.addEventListener(
            "click",
            () => {

                /*
                    Frontend only.

                    The real logout/session
                    invalidation belongs to
                    authentication/backend.

                    For now this only returns
                    to the landing page.
                */

                window.location.href =
                    "LandingPage_Inventory-1.html";

            }
        );

    }

}


/* =====================================================
   ACCOUNT MODAL
===================================================== */

function openAccountModal(
    tab = "profile"
) {

    const overlay =
        document.getElementById(
            "accountModalOverlay"
        );

    if (!overlay) {
        return;
    }

    overlay.classList.add("open");

    document.body.style.overflow =
        "hidden";

    document.documentElement.style.overflow =
        "hidden";

    switchAccountTab(tab);

}


function closeAccountModal() {

    const overlay =
        document.getElementById(
            "accountModalOverlay"
        );

    if (!overlay) {
        return;
    }

    overlay.classList.remove("open");

    document.body.style.overflow =
        "";

    document.documentElement.style.overflow =
        "";

    if (window.passwordFlow) {
        window.passwordFlow.reset();
        updatePasswordChecklist();
    }

}


function switchAccountTab(tab) {

    document
        .querySelectorAll(".modal-tab")
        .forEach(button => {

            button.classList.toggle(
                "active",
                button.dataset.tab === tab
            );

        });


    const profilePanel =
        document.getElementById(
            "profileTabPanel"
        );

    const passwordPanel =
        document.getElementById(
            "passwordTabPanel"
        );


    if (profilePanel) {

        profilePanel.classList.toggle(
            "active",
            tab === "profile"
        );

    }


    if (passwordPanel) {

        passwordPanel.classList.toggle(
            "active",
            tab === "password"
        );

    }

}


/* =====================================================
   PASSWORD STRENGTH
===================================================== */

function evaluatePasswordRules(
    password,
    confirmPassword
) {

    return {

        length:
            password.length >= 8,

        upper:
            /[A-Z]/.test(password),

        lower:
            /[a-z]/.test(password),

        number:
            /[0-9]/.test(password),

        special:
            /[!@#$%^&*()_\-+=\[\]{};:'",.<>\/?\\|`~]/
                .test(password),

        match:
            password.length > 0 &&
            password === confirmPassword

    };

}


function updatePasswordChecklist() {

    const passwordInput =
        document.getElementById(
            "newPasswordInput"
        );

    const confirmInput =
        document.getElementById(
            "confirmPasswordInput"
        );

    const strengthFill =
        document.getElementById(
            "strengthFill"
        );

    const strengthLabel =
        document.getElementById(
            "strengthLabel"
        );


    if (!passwordInput) {
        return;
    }


    const password =
        passwordInput.value;

    const confirmation =
        confirmInput
            ? confirmInput.value
            : "";


    const rules =
        evaluatePasswordRules(
            password,
            confirmation
        );


    document
        .querySelectorAll(
            ".checklist-item"
        )
        .forEach(item => {

            item.classList.toggle(
                "met",
                !!rules[item.dataset.rule]
            );

        });


    const strengthRules = [
        "length",
        "upper",
        "lower",
        "number",
        "special"
    ];


    const count =
        strengthRules.filter(
            rule => rules[rule]
        ).length;


    let percentage = 0;
    let label = "—";
    let color = "var(--red)";


    if (password.length > 0) {

        percentage =
            (count /
                strengthRules.length) *
            100;


        if (count <= 2) {

            label = "Weak";
            color = "var(--red)";

        } else if (count === 3) {

            label = "Fair";
            color = "var(--amber)";

        } else if (count === 4) {

            label = "Good";
            color = "var(--blue-bright)";

        } else {

            label = "Strong";
            color = "var(--green)";

        }

    }


    if (strengthFill) {

        strengthFill.style.width =
            `${percentage}%`;

        strengthFill.style.background =
            color;

    }


    if (strengthLabel) {

        strengthLabel.textContent =
            password.length > 0
                ? `Strength: ${label}`
                : "Strength: —";

    }

}


function initAccountModal() {

    const overlay =
        document.getElementById(
            "accountModalOverlay"
        );

    const closeButton =
        document.getElementById(
            "modalCloseBtn"
        );


    if (closeButton) {

        closeButton.addEventListener(
            "click",
            closeAccountModal
        );

    }


    if (overlay) {

        overlay.addEventListener(
            "click",
            event => {

                if (
                    event.target === overlay
                ) {

                    closeAccountModal();

                }

            }
        );

    }


    document.addEventListener(
        "keydown",
        event => {

            if (
                event.key === "Escape" &&
                overlay &&
                overlay.classList.contains(
                    "open"
                )
            ) {

                closeAccountModal();

            }

        }
    );


    document
        .querySelectorAll(".modal-tab")
        .forEach(button => {

            button.addEventListener(
                "click",
                () => {

                    switchAccountTab(
                        button.dataset.tab
                    );

                }
            );

        });


    const newPassword =
        document.getElementById(
            "newPasswordInput"
        );

    const confirmPassword =
        document.getElementById(
            "confirmPasswordInput"
        );


    if (newPassword) {

        newPassword.addEventListener(
            "input",
            updatePasswordChecklist
        );

    }


    if (confirmPassword) {

        confirmPassword.addEventListener(
            "input",
            updatePasswordChecklist
        );

    }


    const profileCancel =
        document.getElementById(
            "profileCancelBtn"
        );

    if (profileCancel) {

        profileCancel.addEventListener(
            "click",
            closeAccountModal
        );

    }


    /* Save Changes for the profile is handled in api-bridge.js (real database save) */


    const passwordCancel =
        document.getElementById(
            "passwordCancelBtn"
        );

    if (passwordCancel) {

        passwordCancel.addEventListener(
            "click",
            closeAccountModal
        );

    }


    /* Change password: the SAME flow for every role (password-change.js).
       current password typed + checked first -> new password -> a code to the email AND a code to the mobile number -> saved */
    const updatePassword =
        document.getElementById("updatePasswordBtn");

    if (updatePassword && window.PasswordChange) {

        const cur = document.getElementById("currentPasswordInput");
        const nw = document.getElementById("newPasswordInput");
        const conf = document.getElementById("confirmPasswordInput");
        const err = document.getElementById("passwordFormError");

        const setError = (el, message) => {
            el.classList.add("field-invalid");
            clearError(el);
            const m = document.createElement("div");
            m.className = "pc-msg";
            m.style.cssText = "font-size:12.5px;color:var(--red,#c0392b);margin-top:5px";
            m.textContent = message;
            el.insertAdjacentElement("afterend", m);
        };
        const clearError = (el) => {
            el.classList.remove("field-invalid");
            const n = el.nextElementSibling;
            if (n && n.classList.contains("pc-msg")) n.remove();
        };

        window.passwordFlow = PasswordChange.create({
            cur, nw, conf,
            saveBtn: updatePassword,
            otpMount: document.getElementById("passwordOtpMount"),
            api: async (path, options) => {
                const res = await fetch("/api" + path, Object.assign({
                    credentials: "same-origin",
                    headers: { "Content-Type": "application/json" }
                }, options));
                if (res.status === 401) {
                    window.location.href = "Login_Inventory.html";
                    throw new Error("Not signed in");
                }
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { fields: data.fields, status: res.status });
                return data;
            },
            rulesMet: () => Object.values(evaluatePasswordRules(nw.value, conf.value)).every(Boolean),
            setError, clearError,
            banner: (msg) => {
                if (!err) return;
                if (!msg) { err.classList.remove("show"); return; }
                err.textContent = msg;
                err.classList.add("show");
            },
            toast: (msg) => inviteToast(msg),
            onDone: () => { closeAccountModal(); updatePasswordChecklist(); }
        });

    }

    updatePasswordChecklist();

}


/* =====================================================
   DISPATCH
===================================================== */

const dispatchProductsData = [

    {
        sku: "FG-BF-ELB",
        name: 'Brass Forged Elbow 3/4"',
        onHand: 380,
        unit: "pcs",
        qcStatus: "passed"
    },

    {
        sku: "FG-DC-COVR",
        name: "Die-Cast Gearbox Cover 441",
        onHand: 3080,
        unit: "pcs",
        qcStatus: "passed"
    },

    {
        sku: "FG-MC-SHFT",
        name: "Machined Drive Shaft 88mm",
        onHand: 1760,
        unit: "pcs",
        qcStatus: "passed"
    },

    {
        sku: "FG-MC-FLNG",
        name: "Machined Flange 160mm",
        onHand: 220,
        unit: "pcs",
        qcStatus: "passed"
    }

];


let selectedDispatchSku =
    "FG-BF-ELB";


function getDispatchStatusLabel(
    status
) {

    if (status === "passed") {
        return "Passed";
    }

    if (status === "rework") {
        return "Rework";
    }

    return "Pending";

}


function renderFinishedGoodList() {

    const container =
        document.getElementById(
            "finishedGoodList"
        );

    if (!container) {
        return;
    }


    container.innerHTML =
        dispatchProductsData
            .map(product => {

                const passed =
                    product.qcStatus ===
                    "passed";

                const selected =
                    product.sku ===
                    selectedDispatchSku;


                return `

                    <div
                        class="finished-good-item
                        ${selected ? "selected" : ""}
                        ${passed ? "" : "disabled"}"
                        data-sku="${escapeHTML(
                            product.sku
                        )}"
                    >

                        <div>

                            <div class="fg-item-name">
                                ${escapeHTML(
                                    product.name
                                )}
                            </div>

                            <div class="fg-item-sku">
                                ${escapeHTML(
                                    product.sku
                                )}
                            </div>

                        </div>

                        <div class="fg-item-right">

                            <span
                                class="fg-status-pill ${product.qcStatus}"
                            >
                                ${getDispatchStatusLabel(
                                    product.qcStatus
                                )}
                            </span>

                            <span class="fg-qty">

                                ${
                                    passed
                                        ? `${formatNumber(
                                            product.onHand
                                        )} ${escapeHTML(
                                            product.unit
                                        )}`
                                        : "not available"
                                }

                            </span>

                        </div>

                    </div>

                `;

            })
            .join("");


    container
        .querySelectorAll(
            ".finished-good-item"
        )
        .forEach(item => {

            if (
                item.classList.contains(
                    "disabled"
                )
            ) {
                return;
            }


            item.addEventListener(
                "click",
                () => {

                    selectedDispatchSku =
                        item.dataset.sku;

                    renderFinishedGoodList();

                }
            );

        });

}


function initDispatch() {

    renderFinishedGoodList();


    const saveButton =
        document.getElementById(
            "saveDispatchBtn"
        );

    const error =
        document.getElementById(
            "dispatchFormError"
        );


    if (saveButton) {

        saveButton.addEventListener(
            "click",
            event => {

                event.preventDefault();

                const qty =
                    document.getElementById(
                        "dispatchQty"
                    );

                const customer =
                    document.getElementById(
                        "dispatchCustomer"
                    );

                const poRef =
                    document.getElementById(
                        "dispatchPoRef"
                    );


                const valid =
                    qty &&
                    Number(qty.value) > 0 &&
                    customer &&
                    customer.value.trim() &&
                    poRef &&
                    poRef.value.trim();


                if (!valid) {

                    if (error) {
                        error.classList.add(
                            "show"
                        );
                    }

                    return;

                }


                if (error) {
                    error.classList.remove(
                        "show"
                    );
                }

                alert(
                    "Dispatch form ha wala"
                );

            }
        );

    }

}


/* =====================================================
   DASHBOARD BUTTONS
===================================================== */

function initDashboardButtons() {

    const recordMovement =
        document.getElementById(
            "recordMovementBtn"
        );

    if (recordMovement) {

        recordMovement.addEventListener(
            "click",
            () => navigateToPage(
                "stockflow"
            )
        );

    }


    const fullInventory =
        document.getElementById(
            "viewFullInventoryBtn"
        );

    if (fullInventory) {

        fullInventory.addEventListener(
            "click",
            () => navigateToPage(
                "inventory"
            )
        );

    }


    document
        .querySelectorAll(".action-btn")
        .forEach(button => {

            button.addEventListener(
                "click",
                () => {

                    const text =
                        button.textContent
                            .trim();


                    if (
                        text.includes(
                            "Record Movement"
                        )
                    ) {

                        navigateToPage(
                            "stockflow"
                        );

                        return;

                    }


                    alert(
                        `${text} is hehe`
                    );

                }
            );

        });

}


/* =====================================================
   USER MANAGEMENT
===================================================== */

const userAccountsData = [

    {
        name: "Meland G. Dilodilo",
        username: "mdilodilo",
        email: "mdilodilo@triplee-metal.com",
        role: "Cashier",
        roleKey: "Cashier",
        status: "active",
        lastLogin: "2026-08-16 08:02 AM"
    },

    {
        name: "Lourdes L. Alanunay",
        username: "lalanunay",
        email: "lalanunay@triplee-metal.com",
        role: "Finance-Admin Officer",
        roleKey: "finance",
        status: "active",
        lastLogin: "2026-08-16 07:14 AM"
    }

];

const pendingInvitesData = [];


function getInitials(name) {

    return name
        .split(" ")
        .filter(Boolean)
        .map(part => part[0])
        .slice(0, 2)
        .join("")
        .toUpperCase();

}


/* Milliseconds of the user's last sign-in (0 = never). Uses the exact time from the server, else reads "YYYY-MM-DD hh:mm AM". */
function userLoginTime(user) {
    if (user && typeof user.lastLoginAt === "number") return user.lastLoginAt * 1000;
    const m = String((user && user.lastLogin) || "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!m) return 0;
    let h = Number(m[4]) % 12;
    if (/pm/i.test(m[6] || "")) h += 12;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, Number(m[5])).getTime();
}

function renderAccountsTable() {

    const tableBody =
        document.getElementById("accountsTableBody");

    const count =
        document.getElementById("accountCount");

    if (!tableBody) {
        return;
    }

    if (count) {
        count.textContent =
            `${userAccountsData.filter(u => u.roleKey !== "customer").length} account${
                userAccountsData.filter(u => u.roleKey !== "customer").length === 1 ? "" : "s"
            }`;
    }

    const roleSel = document.getElementById("accountRoleFilter");
    const roleWanted = roleSel ? roleSel.value : "all";
    // User Management is for staff only (Finance-Admin and Cashier); customers are managed under Customer Profiles
    const staffCount = userAccountsData.filter(u => u.roleKey !== "customer").length;
    const visible = userAccountsData
        .map((user, index) => ({ user, index }))
        .filter(x => x.user.roleKey !== "customer")
        .filter(x => roleWanted === "all" || x.user.roleKey === roleWanted)
        // latest sign-in on top; accounts that have never signed in go to the bottom (then by name)
        .sort((a, b) => (userLoginTime(b.user) - userLoginTime(a.user)) ||
            String(a.user.name || "").localeCompare(String(b.user.name || "")));

    if (count && roleWanted !== "all") {
        count.textContent = `${visible.length} of ${staffCount} accounts`;
    }

    if (visible.length === 0) {

        tableBody.innerHTML = `
            <tr class="no-results-row">
                <td colspan="6">No accounts found.</td>
            </tr>
        `;

        return;
    }

    tableBody.innerHTML =
        visible.map(({ user, index }) => `

            <tr>

                <td>
                    <div class="user-row-name">
                        <div class="user-row-avatar">
                            ${escapeHTML(getInitials(user.name))}
                            ${user.hasAvatar ? `<img class="user-row-photo" src="/api/users/${encodeURIComponent(user.id)}/avatar" alt="" loading="lazy" decoding="async">` : ""}
                        </div>
                        ${escapeHTML(user.name)}
                    </div>
                </td>

                <td class="dim">
                    ${escapeHTML(user.email || "")}
                </td>

                <td>
                    <span class="role-tag ${user.roleKey === "cashier" ? "cashier" : user.roleKey === "customer" ? "customer" : ""}">
                        ${escapeHTML(user.role)}
                    </span>
                </td>

                <td>
                    <span class="status-pill ${user.status}">
                        ${user.status === "active" ? "Active" : "Disabled"}
                    </span>
                </td>

                <td class="dim">
                    ${escapeHTML(user.lastLogin)}
                </td>

                <td>
                    <div class="row-actions">

                        <button
                            type="button"
                            class="btn-secondary btn-sm user-edit-btn"
                            data-index="${index}"
                        >
                            Edit
                        </button>

                        ${user.roleKey === "finance" ? "" : `
                        <button
                            type="button"
                            class="btn-danger-sm user-disable-btn"
                            data-index="${index}"
                        >
                            ${user.status === "active" ? "Disable" : "Enable"}
                        </button>`}

                    </div>
                </td>

            </tr>

        `).join("");


    tableBody
        .querySelectorAll(".user-edit-btn")
        .forEach(button => {

            button.addEventListener("click", () => {

                openEditUserModal(
                    Number(button.dataset.index)
                );

            });

        });

    tableBody
        .querySelectorAll(".user-disable-btn")
        .forEach(button => {

            button.addEventListener("click", async () => {

                const user =
                    userAccountsData[Number(button.dataset.index)];

                const next = user.status === "active" ? "disabled" : "active";

                if (!confirm(`${next === "disabled" ? "Disable" : "Re-enable"} the account of "${user.name}"?`)) {
                    return;
                }

                try {
                    const res = await fetch("/api/users/" + user.id + "/status", {
                        method: "PATCH",
                        credentials: "same-origin",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ status: next })
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(data.error || "Request failed");
                    user.status = next;
                    renderAccountsTable();
                    inviteToast(`${user.name} ${next === "disabled" ? "disabled" : "re-enabled"}`);
                } catch (err) {
                    inviteToast(err.message, true);
                }

            });

        });

}


function inviteToast(message, isError) {

    const el = document.createElement("div");
    el.className = "app-toast" + (isError ? " error" : "");
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);

}


async function inviteApi(path, options) {

    const res = await fetch("/api/invitations" + path, Object.assign({
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" }
    }, options));

    if (res.status === 401) {
        window.location.href = "Login_Inventory.html";
        throw new Error("Not signed in");
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
        throw Object.assign(
            new Error(data.error || "Request failed"),
            { fields: data.fields }
        );
    }

    return data;

}


async function loadPendingInvites() {

    try {
        const rows = await inviteApi("");
        pendingInvitesData.splice(0, pendingInvitesData.length, ...rows);
    } catch (err) {
        console.warn("[invites] could not load:", err.message);
    }

    renderPendingInvites();

}


function renderPendingInvites() {

    const tableBody =
        document.getElementById("pendingInvitesTableBody");

    if (!tableBody) {
        return;
    }

    if (pendingInvitesData.length === 0) {

        tableBody.innerHTML = `
            <tr class="no-results-row">
                <td colspan="6">No pending invitations.</td>
            </tr>
        `;

        return;
    }

    tableBody.innerHTML =
        pendingInvitesData.map(invite => `

            <tr>
                <td>${escapeHTML(invite.name)}</td>
                <td class="dim">${escapeHTML(invite.email)}</td>
                <td class="dim">${escapeHTML(invite.role)}</td>
                <td class="dim">${escapeHTML(invite.sent)}</td>
                <td>
                    <span class="status-pill ${invite.status === "expired" ? "out" : "watch"}">${invite.status === "expired" ? "Expired" : "Pending"}</span>
                </td>
                <td>
                    <button type="button" class="btn-secondary btn-sm" data-invite-resend="${Number(invite.id)}">
                        Resend
                    </button>
                    <button type="button" class="btn-secondary btn-sm" data-invite-cancel="${Number(invite.id)}">
                        Cancel
                    </button>
                </td>
            </tr>

        `).join("");

}


async function handleInviteAction(event) {

    const resend = event.target.closest("[data-invite-resend]");
    const cancel = event.target.closest("[data-invite-cancel]");
    const button = resend || cancel;

    if (!button) {
        return;
    }

    const id = button.dataset.inviteResend || button.dataset.inviteCancel;
    const invite = pendingInvitesData.find(i => String(i.id) === String(id));

    if (cancel && !confirm("Cancel the invitation for " + (invite ? invite.email : "this person") + "? Their link will stop working.")) {
        return;
    }

    button.disabled = true;

    try {

        if (resend) {
            const r = await inviteApi("/" + id + "/resend", { method: "POST" });
            inviteToast(r.emailSent ? "A new sign-up link was emailed." : r.message, !r.emailSent);
        } else {
            await inviteApi("/" + id, { method: "DELETE" });
            inviteToast("Invitation cancelled.");
        }

    } catch (err) {
        inviteToast(err.message, true);
    }

    await loadPendingInvites();

}


function openInviteUserModal() {

    const overlay =
        document.getElementById("inviteUserModalOverlay");

    if (!overlay) {
        return;
    }

    overlay.classList.add("open");

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

}


function closeInviteUserModal() {

    const overlay =
        document.getElementById("inviteUserModalOverlay");

    if (!overlay) {
        return;
    }

    overlay.classList.remove("open");

    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";

    const form =
        document.getElementById("inviteUserForm");

    if (form) {
        form.reset();
    }

    const error =
        document.getElementById("inviteUserFormError");

    if (error) {
        error.classList.remove("show");
    }

}


function initUserManagement() {

    renderAccountsTable();
    renderPendingInvites();
    loadPendingInvites();
    initEditUserModal();

    const accountRoleFilter = document.getElementById("accountRoleFilter");
    if (accountRoleFilter) accountRoleFilter.addEventListener("change", renderAccountsTable);

    const pendingBody =
        document.getElementById("pendingInvitesTableBody");

    if (pendingBody) {
        pendingBody.addEventListener("click", handleInviteAction);
    }


    const inviteButton =
        document.getElementById("inviteUserBtn");

    if (inviteButton) {
        inviteButton.addEventListener(
            "click",
            openInviteUserModal
        );
    }


    const overlay =
        document.getElementById("inviteUserModalOverlay");

    ["inviteUserCloseBtn", "inviteUserCancelBtn"]
        .forEach(id => {

            const button =
                document.getElementById(id);

            if (button) {
                button.addEventListener(
                    "click",
                    closeInviteUserModal
                );
            }

        });

    if (overlay) {

        overlay.addEventListener("click", event => {

            if (event.target === overlay) {
                closeInviteUserModal();
            }

        });

    }

    document.addEventListener("keydown", event => {

        if (
            event.key === "Escape" &&
            overlay &&
            overlay.classList.contains("open")
        ) {
            closeInviteUserModal();
        }

    });


    const form =
        document.getElementById("inviteUserForm");

    const error =
        document.getElementById("inviteUserFormError");

    if (form) {

        form.addEventListener("submit", async event => {

            event.preventDefault();

            const name =
                document.getElementById("inviteName");

            const email =
                document.getElementById("inviteEmail");

            const role =
                document.getElementById("inviteRole");

            if (
                !name.value.trim() ||
                !email.value.trim()
            ) {

                if (error) {
                    error.textContent = "All fields are required.";
                    error.classList.add("show");
                }

                return;
            }

            if (error) {
                error.classList.remove("show");
            }

            const submit = form.querySelector('button[type="submit"]');
            submit.disabled = true;

            try {

                const r = await inviteApi("", {
                    method: "POST",
                    body: JSON.stringify({
                        name: name.value,
                        email: email.value,
                        role: role.value
                    })
                });

                closeInviteUserModal();

                inviteToast(
                    r.emailSent
                        ? "Invitation sent to " + email.value.trim() + "."
                        : r.message,
                    !r.emailSent
                );

                await loadPendingInvites();

            } catch (err) {

                if (error) {
                    error.textContent = err.message;
                    error.classList.add("show");
                }

            } finally {
                submit.disabled = false;
            }

        });

    }

}


/* =====================================================
   EDIT USER MODAL
===================================================== */

let editingUserIndex = null;
let editUserMounted = false;
let editUserLoaded = false;


function openEditUserModal(index) {

    const overlay =
        document.getElementById("editUserModalOverlay");

    const user =
        userAccountsData[index];

    if (!overlay || !user) {
        return;
    }

    editingUserIndex = index;

    const role =
        document.getElementById("editUserRole");

    // the same profile fields the person has in My Profile (name parts, email, mobile, birthdate, gender, company for customers)
    if (!editUserMounted) {
        ProfileEdit.mount(document.getElementById("editUserMount"), "eu");
        editUserMounted = true;
    }

    const isCust = user.roleKey === "customer";
    ProfileEdit.fill("eu", {}, isCust);
    ProfileEdit.setBusy("eu", true);
    editUserLoaded = false;

    const saveBtn = document.querySelector("#editUserForm [type=\"submit\"]");
    const err = document.getElementById("editUserFormError");
    if (saveBtn) saveBtn.disabled = true;
    if (err) err.classList.remove("show");

    fetch("/api/users/" + user.id + "/profile", { credentials: "same-origin" })
        .then(async res => {
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.error || "Could not load this profile");
            if (editingUserIndex !== index) return;
            ProfileEdit.fill("eu", d, isCust);
            ProfileEdit.setBusy("eu", false);
            editUserLoaded = true;
            if (saveBtn) saveBtn.disabled = false;
            const first = document.getElementById("euFirst");
            if (first) first.focus();
        })
        .catch(e => {
            if (err) { err.textContent = e.message; err.classList.add("show"); }
        });

    if (role) {
        // a customer stays a customer; staff can only be Finance-Admin or Cashier
        const isCustomer = user.roleKey === "customer";
        role.querySelectorAll("option").forEach(o => {
            o.hidden = o.disabled = isCustomer ? o.value !== "Customer" : o.value === "Customer";
        });
        role.value = isCustomer ? "Customer"
            : user.roleKey === "cashier" ? "Cashier" : "Finance-Admin Officer";
        role.disabled = isCustomer;
    }

    overlay.classList.add("open");

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

}


function closeEditUserModal() {

    const overlay =
        document.getElementById("editUserModalOverlay");

    if (!overlay) {
        return;
    }

    overlay.classList.remove("open");

    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";

    const form =
        document.getElementById("editUserForm");

    if (form) {
        form.reset();
    }

    const error =
        document.getElementById("editUserFormError");

    if (error) {
        error.classList.remove("show");
    }

    editingUserIndex = null;

}


function initEditUserModal() {

    const overlay =
        document.getElementById("editUserModalOverlay");

    ["editUserCloseBtn", "editUserCancelBtn"]
        .forEach(id => {

            const button =
                document.getElementById(id);

            if (button) {
                button.addEventListener(
                    "click",
                    closeEditUserModal
                );
            }

        });

    if (overlay) {

        overlay.addEventListener("click", event => {

            if (event.target === overlay) {
                closeEditUserModal();
            }

        });

    }

    document.addEventListener("keydown", event => {

        if (
            event.key === "Escape" &&
            overlay &&
            overlay.classList.contains("open")
        ) {
            closeEditUserModal();
        }

    });


    const form =
        document.getElementById("editUserForm");

    const error =
        document.getElementById("editUserFormError");

    if (form) {

        form.addEventListener("submit", event => {

            event.preventDefault();

            const user = userAccountsData[editingUserIndex];

            if (!user || !editUserLoaded) {
                return;
            }

            const isCust = user.roleKey === "customer";
            const bad = ProfileEdit.check("eu", isCust);

            if (Object.keys(bad).length) {
                ProfileEdit.showErrors("eu", bad);
                if (error) {
                    error.textContent = "Please fix the highlighted fields.";
                    error.classList.add("show");
                }
                return;
            }

            if (error) {
                error.classList.remove("show");
            }

            const roleSel = document.getElementById("editUserRole");
            const roleKey = isCust ? "customer"
                : roleSel.value === "Cashier" ? "cashier" : "finance";
            const submitBtn = form.querySelector('[type="submit"]');

            if (submitBtn) submitBtn.disabled = true;

            const body = ProfileEdit.read("eu", isCust);
            body.roleKey = roleKey;

            fetch("/api/users/" + user.id, {
                method: "PATCH",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            })
                .then(async res => {
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { fields: data.fields });
                    user.name = data.name;
                    user.email = data.email;
                    user.roleKey = roleKey;
                    user.role = roleKey === "finance" ? "Finance-Admin Officer"
                        : roleKey === "cashier" ? "Sales Staff / Cashier" : "Customer";
                    closeEditUserModal();
                    renderAccountsTable();
                    inviteToast("Account updated" + (data.message ? " \u2014 " + data.message : ""));
                })
                .catch(err => {
                    if (ProfileEdit.showErrors("eu", err.fields)) {
                        if (error) { error.textContent = "Please fix the highlighted fields."; error.classList.add("show"); }
                    } else if (error) {
                        error.textContent = err.message;
                        error.classList.add("show");
                    } else {
                        inviteToast(err.message, true);
                    }
                })
                .finally(() => { if (submitBtn) submitBtn.disabled = false; });

        });

    }

}


/* =====================================================
   AUDIT LOG
===================================================== */

const auditLogData = [

    {
        timestamp: "2026-08-16 07:14 AM",
        user: "Lourdes L. Alanunay",
        role: "Finance-Admin",
        action: "Login",
        detail: "Successful login"
    },

    {
        timestamp: "2026-08-16 07:16 AM",
        user: "Lourdes L. Alanunay",
        role: "Finance-Admin",
        action: "Record added",
        detail: "Stock In — MV-8841, Brass Billet C36000, +1,800 kg"
    },

    {
        timestamp: "2026-08-15 04:40 PM",
        user: "Lourdes L. Alanunay",
        role: "Finance-Admin",
        action: "Record edited",
        detail: "Product updated — Machined Drive Shaft 88mm, reorder level changed 450 to 500"
    },

    {
        timestamp: "2026-08-15 09:00 AM",
        user: "Meland G. Dilodilo",
        role: "Cashier",
        action: "Login",
        detail: "Successful login"
    },

    {
        timestamp: "2026-08-14 02:22 PM",
        user: "Lourdes L. Alanunay",
        role: "Finance-Admin",
        action: "Record added",
        detail: "Dispatch — PO-2213, Die-Cast Gearbox Cover 441, 140 pcs"
    },

    {
        timestamp: "2026-08-13 11:08 AM",
        user: "Lourdes L. Alanunay",
        role: "Finance-Admin",
        action: "Record added",
        detail: "Stock Out — MV-8836, Die-Cast Mounting Bracket, -540 pcs"
    },

    {
        timestamp: "2026-08-12 05:30 PM",
        user: "Meland G. Dilodilo",
        role: "Cashier",
        action: "Account created",
        detail: "New Finance-Admin account provisioned for L. Alanunay"
    }

];


function getAuditActionClass(action) {

    switch (action) {
        case "Login":           return "login";
        case "Logout":          return "login";
        case "Record added":    return "added";
        case "Record edited":   return "edited";
        case "Account created": return "account";
        case "Cash shift":      return "cashshift";
        case "Return":          return "return";
        default:                return "";
    }

}


function applyAuditFilters() {

    const roleFilter =
        document.getElementById("auditRoleFilter");

    const actionFilter =
        document.getElementById("auditActionFilter");

    const searchInput =
        document.getElementById("auditSearch");

    const countEl =
        document.getElementById("auditCount");

    const tableBody =
        document.getElementById("auditTableBody");

    if (!tableBody) {
        return;
    }

    const role =
        roleFilter ? roleFilter.value : "all";

    const action =
        actionFilter ? actionFilter.value : "all";

    const term =
        searchInput
            ? searchInput.value.trim().toLowerCase()
            : "";


    const filtered =
        auditLogData.filter(entry => {

            const roleMatch =
                role === "all" || String(entry.role || "").toLowerCase().includes(role.toLowerCase());

            const actionMatch =
                action === "all" || entry.action === action;

            const searchMatch =
                !term ||
                entry.user.toLowerCase().includes(term) ||
                entry.action.toLowerCase().includes(term) ||
                entry.detail.toLowerCase().includes(term);

            return roleMatch && actionMatch && searchMatch;

        });


    if (countEl) {
        countEl.textContent =
            `${filtered.length} of ${auditLogData.length} entries`;
    }

    if (filtered.length === 0) {

        tableBody.innerHTML = `
            <tr class="no-results-row">
                <td colspan="5">No log entries match your filters.</td>
            </tr>
        `;

        return;
    }

    tableBody.innerHTML =
        filtered.map(entry => `

            <tr>

                <td class="mono">
                    ${escapeHTML(entry.timestamp)}
                </td>

                <td>
                    ${escapeHTML(entry.user)}
                </td>

                <td>
                    <span class="role-tag ${/cashier/i.test(entry.role) ? "cashier" : /customer/i.test(entry.role) ? "customer" : ""}">
                        ${escapeHTML(entry.role)}
                    </span>
                </td>

                <td>
                    <span class="action-tag ${getAuditActionClass(entry.action)}">
                        ${escapeHTML(entry.action)}
                    </span>
                </td>

                <td class="audit-detail">
                    ${escapeHTML(entry.detail)}
                </td>

            </tr>

        `).join("");

}


function initAuditLog() {

    applyAuditFilters();

    const roleFilter =
        document.getElementById("auditRoleFilter");

    const actionFilter =
        document.getElementById("auditActionFilter");

    const searchInput =
        document.getElementById("auditSearch");

    if (roleFilter) {
        roleFilter.addEventListener("change", applyAuditFilters);
    }

    if (actionFilter) {
        actionFilter.addEventListener("change", applyAuditFilters);
    }

    if (searchInput) {
        searchInput.addEventListener("input", applyAuditFilters);
    }

}


/* =====================================================
   INITIALIZATION
===================================================== */

document.addEventListener(
    "DOMContentLoaded",
    () => {

        function safeInit(
            name,
            callback
        ) {

            try {

                callback();

            } catch (error) {

                console.error(
                    `UI initialization failed: ${name}`,
                    error
                );

            }

        }


        safeInit(
            "navigation",
            initNavigation
        );

        safeInit(
            "dashboard",
            loadDashboard
        );

        safeInit(
            "dashboard buttons",
            initDashboardButtons
        );

        safeInit(
            "inventory monitoring",
            initInventoryMonitoring
        );

        safeInit(
            "stock in/out",
            initStockInOut
        );

        safeInit(
            "products",
            initProductCatalog
        );

        safeInit(
            "suppliers",
            initSuppliers
        );

        safeInit(
            "supplier modal",
            initNewSupplierModal
        );

        safeInit(
            "reports",
            initReports
        );

        safeInit(
            "user menu",
            initUserMenu
        );

        safeInit(
            "account modal",
            initAccountModal
        );

        safeInit(
            "dispatch",
            initDispatch
        );

        safeInit(
            "user management",
            initUserManagement
        );

        safeInit(
            "audit log",
            initAuditLog
        );

    }
);