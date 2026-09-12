# Celestial Goods — Organic & Artisanal Delicacies E-Commerce

Full-stack E-Commerce platform for **Celestial Goods**, featuring a dynamic storefront and an interactive admin dashboard backed by SQLite.

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start Servers

To run **both** Storefront and Admin backend concurrently:
```bash
npm run start:all
# or
npm run dev
```

Or run them individually:
```bash
# Storefront Server (Port 3000)
npm run start:storefront

# Admin Dashboard Server (Port 5050)
npm run start:admin
```

---

## 📍 Port Architecture

| Application | URL | Purpose |
| :--- | :--- | :--- |
| **Storefront App** | `http://localhost:3000` | Main customer-facing e-commerce shop, product catalog, cart, and checkout |
| **Admin Dashboard** | `http://localhost:5050` | Admin portal for managing products, billboards, categories, orders, and settings |

---

## 🔑 Admin Access

To access the admin panel, set up your admin credentials via the `OWNER_USERNAME` and `OWNER_PASSWORD` environment variables. The default admin account is created on first run through the seeding process.

---

## ✨ Features & Capabilities

- 🛍️ **Dynamic Front-End Hydration:** Real-time data loading for products, categories, billboards/advertisements, testimonials, and site settings directly from SQLite.
- 🛡️ **Interactive Admin Portal:** Full CRUD management for products (prices, variants, images, badges), billboards/hero banners, categories, and site settings.
- 📊 **Order Management & Analytics:** Real-time order tracking, revenue statistics, and graph analytics.
- 🛒 **Seamless Checkout:** Customer order placement directly integrated with backend order processing.
- 🗄️ **Zero External DB Overhead:** Native SQLite (`node:sqlite`) with WAL mode for fast concurrent operations.
