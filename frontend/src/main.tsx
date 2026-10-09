import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import './styles.css';
import AdminAvailability from './pages/admin/AdminAvailability';
import AdminLayout from './pages/admin/AdminLayout';
import AdminMenuPage from './pages/admin/AdminMenu';
import AdminOrders from './pages/admin/AdminOrders';
import MenuPage from './pages/MenuPage';
import OrderPage from './pages/OrderPage';

function App() {
  return (
    <BrowserRouter>
      <nav className="topnav" aria-label="Main">
        <span className="brand">The Order Taker</span>
        <div>
          <NavLink to="/" end>Order</NavLink>
          <NavLink to="/menu">Menu</NavLink>
          <NavLink to="/staff">Staff</NavLink>
        </div>
      </nav>
      <Routes>
        <Route path="/" element={<OrderPage />} />
        <Route path="/menu" element={<MenuPage />} />
        <Route path="/staff" element={<AdminLayout />}>
          <Route index element={<Navigate to="orders" replace />} />
          <Route path="orders" element={<AdminOrders />} />
          <Route path="menu" element={<AdminMenuPage />} />
          <Route path="availability" element={<AdminAvailability />} />
        </Route>
        <Route path="*" element={<div className="center-screen">Page not found</div>} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
