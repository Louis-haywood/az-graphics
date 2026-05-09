const CART_KEY = 'azg_cart';

const Cart = {
    get() {
        try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
        catch { return []; }
    },
    save(items) {
        localStorage.setItem(CART_KEY, JSON.stringify(items));
        Cart.updateBadge();
    },
    add(product) {
        const items = Cart.get();
        const existing = items.find(i => i.id === product.id);
        if (existing) {
            existing.qty = (existing.qty || 1) + 1;
        } else {
            items.push({ ...product, qty: 1 });
        }
        Cart.save(items);
        Toast.show(`${product.name} added to cart`);
    },
    remove(id) {
        const items = Cart.get().filter(i => i.id !== id);
        Cart.save(items);
        if (typeof renderCart === 'function') renderCart();
    },
    total() {
        return Cart.get().reduce((sum, i) => sum + i.price * (i.qty || 1), 0);
    },
    count() {
        return Cart.get().reduce((sum, i) => sum + (i.qty || 1), 0);
    },
    updateBadge() {
        const badges = document.querySelectorAll('.cart-count');
        const c = Cart.count();
        badges.forEach(b => {
            b.textContent = c;
            b.classList.toggle('visible', c > 0);
        });
    },
    clear() {
        localStorage.removeItem(CART_KEY);
        Cart.updateBadge();
    }
};

const Toast = {
    container: null,
    init() {
        if (Toast.container) return;
        Toast.container = document.createElement('div');
        Toast.container.className = 'toast-container';
        document.body.appendChild(Toast.container);
    },
    show(msg) {
        Toast.init();
        const el = document.createElement('div');
        el.className = 'toast';
        el.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg><span>${msg}</span>`;
        Toast.container.appendChild(el);
        setTimeout(() => {
            el.classList.add('removing');
            el.addEventListener('animationend', () => el.remove());
        }, 3000);
    }
};

const Modal = {
    el: null,
    pendingProduct: null,
    init() {
        Modal.el = document.getElementById('proofModal');
        if (!Modal.el) return;
        document.getElementById('modalConfirm').addEventListener('click', () => {
            if (Modal.pendingProduct) Cart.add(Modal.pendingProduct);
            Modal.close();
        });
        document.getElementById('modalCancel').addEventListener('click', Modal.close);
        Modal.el.addEventListener('click', e => { if (e.target === Modal.el) Modal.close(); });
    },
    open(product) {
        Modal.pendingProduct = product;
        const nameEl = document.getElementById('modalProductName');
        if (nameEl) nameEl.textContent = product.name;
        Modal.el.classList.add('open');
        document.body.style.overflow = 'hidden';
    },
    close() {
        if (!Modal.el) return;
        Modal.el.classList.remove('open');
        Modal.pendingProduct = null;
        document.body.style.overflow = '';
    }
};

function handleAddToCart(btn) {
    const id       = btn.dataset.id;
    const name     = btn.dataset.name;
    const price    = parseFloat(btn.dataset.price);
    const category = btn.dataset.category;
    const requires = btn.dataset.requiresProof === 'true';

    const product = { id, name, price, category };

    if (requires) {
        Modal.open(product);
    } else {
        Cart.add(product);
    }
}

/* ── Cart page renderer ── */
function renderCart() {
    const listEl    = document.getElementById('cartList');
    const emptyEl   = document.getElementById('cartEmpty');
    const summaryEl = document.getElementById('cartSummary');
    if (!listEl) return;

    const items = Cart.get();

    if (items.length === 0) {
        listEl.style.display    = 'none';
        summaryEl.style.display = 'none';
        emptyEl.style.display   = 'block';
        return;
    }

    emptyEl.style.display   = 'none';
    listEl.style.display    = 'flex';
    summaryEl.style.display = 'block';

    listEl.innerHTML = items.map(item => `
        <div class="cart-item">
            <div class="cart-item-info">
                <div class="cart-item-name">${item.name}</div>
                <div class="cart-item-cat">${item.category}</div>
            </div>
            <div class="cart-item-price">£${(item.price * (item.qty || 1)).toFixed(2)}</div>
            <button class="cart-remove" onclick="Cart.remove('${item.id}')" aria-label="Remove">
                <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/></svg>
            </button>
        </div>
    `).join('');

    const total = Cart.total();
    document.getElementById('summaryItems').textContent  = items.reduce((s,i)=>s+(i.qty||1),0) + ' item(s)';
    document.getElementById('summaryTotal').textContent  = `£${total.toFixed(2)}`;
    document.getElementById('summaryTotal2').textContent = `£${total.toFixed(2)}`;
}

document.addEventListener('DOMContentLoaded', () => {
    Cart.updateBadge();
    Modal.init();
    if (document.getElementById('cartList')) renderCart();

    /* Hamburger */
    const ham = document.getElementById('hamburger');
    const nav = document.getElementById('navLinks');
    if (ham && nav) {
        ham.addEventListener('click', () => nav.classList.toggle('open'));
    }

    /* Bind add-to-cart buttons */
    document.querySelectorAll('.add-to-cart').forEach(btn => {
        btn.addEventListener('click', () => handleAddToCart(btn));
    });
});
