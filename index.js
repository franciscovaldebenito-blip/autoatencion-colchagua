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

    // 1. Obtener cliente desde colcha_clientes (SE AGREGA 'email' A LA CONSULTA)
    const { data: cliente, error: errCliente } = await supabase
      .from('colcha_clientes')
      .select('rut, nombre, email, direccion, c_pago, linea_de_credito, descuento, lista, vendedor_1')
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

    // 2.1 Obtener cheques desde col_cheques
    const { data: cheques, error: errCheques } = await supabase
      .from('col_cheques')
      .select('saldo, cliente')
      .or(`cliente.eq.${rutLimpio},cliente.ilike.%${rutLimpio}%`);

    let montoCheques = 0;

    if (!errCheques && cheques && cheques.length > 0) {
      cheques.forEach(ch => {
        const valorSaldo = Number(ch.saldo || 0);
        montoCheques += valorSaldo;
      });
    } else if (errCheques) {
      console.error("⚠️ Error consulta cheques:", errCheques);
    }

    // 3. Buscar información del vendedor en colcha_info_vendedores
    const rawVendedor = (cliente.vendedor_1 && cliente.vendedor_1.trim() !== '') 
      ? cliente.vendedor_1.trim() 
      : 'Novovet';

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

    // ==========================================
    // 4. CARGAR TODOS LOS ARTÍCULOS (PAGINACIÓN) Y PROMOCIONES
    // ==========================================
    let todosLosArticulos = [];
    let desde = 0;
    const paso = 1000;
    let hayMasRegistros = true;

    while (hayMasRegistros) {
      const { data: bloque, error: errArt } = await supabase
        .from('colcha_articulos')
        .select('*')
        .range(desde, desde + paso - 1);

      if (errArt) throw errArt;

      if (bloque && bloque.length > 0) {
        todosLosArticulos = todosLosArticulos.concat(bloque);
        desde += paso;

        if (bloque.length < paso) {
          hayMasRegistros = false;
        }
      } else {
        hayMasRegistros = false;
      }
    }

    // Cargar promociones con código sanitizado
    const { data: resPromociones } = await supabase.from('Colcha_promociones').select('*');

    const mapaPromos = new Map();
    if (resPromociones && resPromociones.length > 0) {
      resPromociones.forEach(p => {
        if (p.codigo) {
          mapaPromos.set(String(p.codigo).trim().toUpperCase(), p);
        }
      });
    }

    // ==========================================
    // 5. PROCESAR PRODUCTOS Y APLICAR DESCUENTOS
    // ==========================================
    const productos = todosLosArticulos.map(art => {
      const precioBruto = art[columnaLista] !== undefined && art[columnaLista] !== null 
        ? art[columnaLista] 
        : art.lista_1;
        
      const precioBase = Number(precioBruto || 0);
      const codigoKey = String(art.codigo || '').trim().toUpperCase();
      const promoData = mapaPromos.get(codigoKey);

      let tienePromo = false;
      let porcentajeDcto = 0;
      let precioFinal = precioBase;
      let tipoPromo = null;
      let reglaVolumen = null;

      if (promoData && String(promoData.aplica_promo || '').trim().toUpperCase() === 'SI') {
        const f1 = promoData.factor_1 !== null && promoData.factor_1 !== undefined ? parseFloat(promoData.factor_1) : null;
        const f2 = promoData.factor_2 !== null && promoData.factor_2 !== undefined ? parseFloat(promoData.factor_2) : null;
        const f4 = promoData.factor_4 !== null && promoData.factor_4 !== undefined ? parseFloat(promoData.factor_4) : null;

        if (f4 !== null && !isNaN(f4) && f4 > 0) {
          tienePromo = true;
          tipoPromo = 'PORCENTAJE';
          const factorDecimal = f4 > 1 ? f4 / 100 : f4;
          porcentajeDcto = Math.round(factorDecimal * 100);
          precioFinal = Math.round(precioBase * (1 - factorDecimal));
        } else if (f1 !== null && !isNaN(f1) && f1 > 0) {
          tienePromo = true;
          tipoPromo = 'VOLUMEN';
          reglaVolumen = { 
            factor1: f1, 
            factor2: (f2 && !isNaN(f2)) ? f2 : 0, 
            x: f1, 
            y: (f2 && !isNaN(f2)) ? f2 : 0 
          };
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

    // 6. Cálculo de uso de crédito
    const limiteCreditoNum = Number(cliente.linea_de_credito || 0);
    const deudaTotalUso = montoVencido + montoVigente + montoCheques;
    const porcentajeUso = limiteCreditoNum > 0 ? (deudaTotalUso / limiteCreditoNum) * 100 : 0;
    const creditoExcedido = deudaTotalUso > limiteCreditoNum;
    const creditoCasiAlLimite = !creditoExcedido && porcentajeUso >= 80;

    // 7. Respuesta JSON (SE AGREGA 'email' AL OBJETO CLIENTE)
    return res.json({
      exito: true,
      cliente: {
        rut: cliente.rut,
        nombre: cliente.nombre,
        email: cliente.email || '', // <-- AHORA SÍ ENVIAMOS EL EMAIL
        direccion: cliente.direccion,
        condicionPago: cliente.c_pago,
        condicion: cliente.c_pago,
        lineaCredito: limiteCreditoNum,
        credito: limiteCreditoNum,
        descuentoCliente: cliente.descuento,
        descuento: cliente.descuento,
        montoVencido,
        montoVigente,
        montoCheques,
        porcentajeUso: Math.round(porcentajeUso),
        creditoExcedido,
        creditoCasiAlLimite,
        vendedor: vendedorNombre,
        vendedorCorreo: vendedorCorreo,
        vendedorTelefono: vendedorTelefono,
        listaAplicada: numeroLista
      },
      productos
    });

  } catch (error) {
    console.error('Error al cargar catálogo:', error.message);
    return res.status(500).json({ exito: false, mensaje: 'Error al procesar el catálogo: ' + error.message });
  }
});

// ==========================================
// 2. GUARDAR PEDIDO Y ENVIAR NOTIFICACIÓN
// ==========================================
app.post('/api/pedidos', async (req, res) => {
  try {
    const { cliente, productos, comentario, resumen } = req.body;

    const numeroAleatorio = Math.floor(100000 + Math.random() * 900000);
    const codigoPedido = `NV-${numeroAleatorio}`;

    const fechaActual = new Date();
    const fecha = fechaActual.toISOString().split('T')[0];
    const hora = fechaActual.toTimeString().split(' ')[0];

    // 1. Insertar Cabecera en Supabase
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

    // 2. Insertar Detalle en Supabase
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

    // 3. Notificación a Google Apps Script
    const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwLyIfAfAAqWmME2prGHxKeFJB5QU93KCWwgNepqGeOy8QfK05Iz7zUmuYG3jEkp1Va/exec';

    try {
      const payloadGoogle = {
        codigoPedido: codigoPedido,
        cliente: {
          rut: cliente.rut || '',
          nombre: cliente.nombre || '',
          correo: cliente.correo || cliente.email || '',
          vendedor: cliente.vendedor || 'Novovet',
          vendedorCorreo: cliente.vendedorCorreo || cliente.correoVendedor || ''
        },
        productos: productos,
        resumen: {
          subtotal: resumen.subtotal || resumen.subtotalNeto || 0,
          descuento: resumen.descuento || resumen.descuentoMonto || 0,
          iva: resumen.iva || 0,
          total: resumen.total || resumen.totalFinal || 0
        },
        comentario: comentario || ''
      };

      const respScript = await fetch(GOOGLE_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadGoogle)
      });

      const resultadoAppsScript = await respScript.text();
      console.log('📬 Respuesta de Google Apps Script:', resultadoAppsScript);

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