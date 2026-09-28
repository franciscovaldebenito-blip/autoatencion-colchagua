import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// ==========================================
// 1. OBTENER CATÁLOGO POR RUT DE CLIENTE
// ==========================================
app.get('/api/catalogo/:rut', async (req, res) => {
  const { rut } = req.params;

  try {
    const rutLimpio = String(rut).trim();

    // 1. Obtener cliente
    const { data: cliente, error: errCliente } = await supabase
      .from('colcha_clientes')
      .select('rut, nombre, direccion, c_pago, linea_de_credito, descuento, lista, vendedor_1')
      .eq('rut', rutLimpio)
      .maybeSingle();

    if (errCliente) throw errCliente;
    if (!cliente) {
      return res.status(404).json({ exito: false, mensaje: 'Cliente no encontrado.' });
    }

    // 2. Obtener cobranzas desde col_cobranza
    const { data: cobranzas, error: errCobranza } = await supabase
      .from('col_cobranza')
      .select('*')
      .eq('cliente', rutLimpio);

    let montoVencido = 0;
    let montoVigente = 0;

    if (!errCobranza && cobranzas) {
      cobranzas.forEach(f => {
        const valorFactura = Number(f.monto || f.saldo || f.total || 0);
        const estadoFactura = String(f.estado || '').toLowerCase().trim();

        if (estadoFactura.includes('vencid')) {
          montoVencido += valorFactura;
        } else if (estadoFactura.includes('vencer') || estadoFactura.includes('vigente') || estadoFactura.includes('por vender')) {
          montoVigente += valorFactura;
        }
      });
    }

    // 3. Buscar información del vendedor
    const rawVendedor = (cliente.vendedor_1 && cliente.vendedor_1.trim() !== '') 
      ? cliente.vendedor_1.trim() 
      : 'novovet';

    let vendedorCorreo = '-';
    let vendedorTelefono = '-';
    let vendedorNombre = rawVendedor;

    const { data: todosVendedores } = await supabase
      .from('colcha_info_vendedores')
      .select('*');

    if (todosVendedores && todosVendedores.length > 0) {
      const normBuscado = rawVendedor.toLowerCase().replace(/\s+/g, ' ');
      
      const hallado = todosVendedores.find(v => {
        const valNombre = String(v.nombre || v.Nombre || '').toLowerCase().replace(/\s+/g, ' ');
        return valNombre.includes(normBuscado) || normBuscado.includes(valNombre);
      });

      if (hallado) {
        vendedorNombre = hallado.nombre || hallado.Nombre || rawVendedor;
        vendedorCorreo = hallado.correo || hallado.Correo || '-';
        vendedorTelefono = hallado.telefono || hallado.Telefono || hallado.telef || '-';
      }
    }

    const numeroLista = cliente.lista || 1;
    const columnaLista = `lista_${numeroLista}`;

    // 4. Cargar artículos y promociones
    const [resArticulos, resPromociones] = await Promise.all([
      supabase.from('colcha_articulos').select('*'),
      supabase.from('Colcha_promociones').select('*')
    ]);

    if (resArticulos.error) throw resArticulos.error;
    if (resPromociones.error) throw resPromociones.error;

    const mapaPromos = new Map();
    resPromociones.data.forEach(p => mapaPromos.set(p.codigo, p));

    // 5. Procesar productos
    const productos = resArticulos.data.map(art => {
      const precioBase = art[columnaLista] || 0;
      const promoData = mapaPromos.get(art.codigo);

      let tienePromo = false;
      let porcentajeDcto = 0;
      let precioFinal = precioBase;
      let tipoPromo = null;
      let reglaVolumen = null;

      if (promoData && (promoData.aplica_promo === 'Si' || promoData.aplica_promo === 'SI')) {
        const f1 = promoData.factor_1 !== null && promoData.factor_1 !== undefined ? Number(promoData.factor_1) : null;
        const f2 = promoData.factor_2 !== null && promoData.factor_2 !== undefined ? Number(promoData.factor_2) : null;
        const f4 = promoData.factor_4 !== null && promoData.factor_4 !== undefined ? Number(promoData.factor_4) : null;

        if (f1 !== null && f1 > 0) {
          tienePromo = true;
          tipoPromo = 'VOLUMEN';
          reglaVolumen = { factor1: f1, factor2: f2 ?? 0, x: f1, y: f2 ?? 0 };
        } else if (f4 !== null && f4 > 0) {
          tienePromo = true;
          tipoPromo = 'PORCENTAJE';
          porcentajeDcto = Math.round(f4 * 100);
          precioFinal = Math.round(precioBase * (1 - f4));
        }
      }

      return {
        codigo: art.codigo,
        nombre: art.nombre,
        familia: art.familia_de,
        superFamilia: art.super_familia,
        proveedor: art.proveedor || art.grupo || 'Novovet',
        precioBase,
        precioFinal,
        tienePromo,
        tipoPromo,
        descuentoPorcentaje: porcentajeDcto,
        reglaVolumen,
        promocionInfo: promoData || null
      };
    });

    // 6. Respuesta JSON
    return res.json({
      exito: true,
      cliente: {
        rut: cliente.rut,
        nombre: cliente.nombre,
        direccion: cliente.direccion,
        condicionPago: cliente.c_pago,
        lineaCredito: cliente.linea_de_credito,
        descuentoCliente: cliente.descuento,
        montoVencido,
        montoVigente,
        vendedor: vendedorNombre,
        vendedorCorreo: vendedorCorreo,
        vendedorTelefono: vendedorTelefono,
        listaAplicada: numeroLista
      },
      productos
    });

  } catch (error) {
    console.error('Error al cargar catálogo:', error.message);
    return res.status(500).json({ exito: false, mensaje: 'Error al procesar el catálogo.' });
  }
});


// ==========================================
// 2. GUARDAR PEDIDO Y ENVIAR NOTIFICACIÓN
// ==========================================
app.post('/api/pedidos', async (req, res) => {
  try {
    const { cliente, productos, comentario, resumen } = req.body;

    // 1. Generar código único para el pedido
    const numeroAleatorio = Math.floor(100000 + Math.random() * 900000);
    const codigoPedido = `NV-${numeroAleatorio}`;

    const fechaActual = new Date();
    const fecha = fechaActual.toISOString().split('T')[0];
    const hora = fechaActual.toTimeString().split(' ')[0];

    // 2. Insertar PRIMERO la cabecera en "col_pedidos"
    const { data: pedidoCreado, error: errCabecera } = await supabase
      .from('col_pedidos')
      .insert([
        {
          codigo_pedido: codigoPedido,
          rut: cliente.rut,
          nombre: cliente.nombre,
          fecha: fecha,
          hora: hora,
          vendedor: cliente.vendedor,
          estado: 'PENDIENTE',
          direccion: cliente.direccion,
          comentario_cliente: comentario
        }
      ])
      .select();

    if (errCabecera) {
      console.error('Error al insertar cabecera:', errCabecera);
      return res.status(500).json({
        exito: false,
        mensaje: `Error en col_pedidos: ${errCabecera.message}`
      });
    }

    // 3. Insertar DESPUÉS las líneas en "col_detalle_pedidos"
    const lineasDetalle = productos.map(item => ({
      codigo_pedido: codigoPedido,
      producto: item.nombre,
      cantidad: item.cantidad,
      precio: item.precio,
      promo: item.promo
    }));

    const { error: errDetalle } = await supabase
      .from('col_detalle_pedidos')
      .insert(lineasDetalle);

    if (errDetalle) {
      console.error('Error al insertar detalle:', errDetalle);
      return res.status(500).json({
        exito: false,
        mensaje: `Error en col_detalle_pedidos: ${errDetalle.message}`
      });
    }

    // 4. Notificación vía Google Apps Script (Síncrono para auditar errores)
    const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwLyIfAfAAqWmME2prGHxKeFJB5QU93KCWwgNepqGeOy8QfK05Iz7zUmuYG3jEkp1Va/exec';

    try {
      const respScript = await fetch(GOOGLE_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codigoPedido,
          cliente,
          productos,
          resumen,
          comentario
        })
      });

      const resultadoAppsScript = await respScript.text();
      console.log('📬 Respuesta de Apps Script:', resultadoAppsScript);

    } catch (errCorreo) {
      console.error('⚠️ Error al conectar con Google Apps Script:', errCorreo.message);
    }

    return res.json({ 
      exito: true, 
      codigoPedido 
    });

  } catch (err) {
    console.error('Error en el servidor:', err.message);
    return res.status(500).json({ exito: false, mensaje: 'Error al registrar pedido: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en http://localhost:${PORT}`);
});