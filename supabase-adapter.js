/* Chewbbie Taller · adaptador Supabase para conservar la interfaz original */
const CHEWBBIE_SUPABASE_URL = "https://nbuxhgdjymabljzoseie.supabase.co";
const CHEWBBIE_SUPABASE_KEY = "sb_publishable_KTa0S1P763CzrXCUWO8nPA_BXki_5MO";
const SUPA = window.supabase.createClient(CHEWBBIE_SUPABASE_URL, CHEWBBIE_SUPABASE_KEY, {
  db: { schema: "chewbbie" },
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
const CDB = SUPA.schema("chewbbie");
S.citas = [];
S.equipo = [];
S.rol = "";
S.usuario_id = "";
S.email = "";
let OTP_ENVIADO = false;
let EMAIL_OTP = "";
let CITA_ACTUAL = null;
let AGENDA_FECHA = hoyISO();

const esAdmin = () => S.rol === "admin";
const requireSession = async () => {
  const r = await SUPA.auth.getSession();
  if (r.error || !r.data.session) throw new Error("Tu sesión terminó. Ingresa de nuevo.");
  TOKEN = r.data.session.access_token;
  return r.data.session.user;
};
const exigirAdmin = () => { if (!esAdmin()) throw new Error("Esta función está disponible solo para administradores."); };
const unwrap = (r, label) => {
  if (r.error) throw new Error((label ? label + ": " : "") + r.error.message);
  return r.data;
};
const toIsoDate = (date) => date ? new Date(date).toISOString().slice(0, 10) : "";
const localISODate = (value) => { const d=new Date(value); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };
const dateInputLocal = (value) => {
  const d = value ? new Date(value) : new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const toDbStatus = (v) => ({ "Pendiente":"received", "En proceso":"in_progress", "Finalizada":"ready", "Cancelada":"cancelled" }[v] || "received");
const toUiStatus = (v) => {
  if (v === "received") return "Pendiente";
  if (v === "ready" || v === "delivered") return "Finalizada";
  if (v === "cancelled") return "Cancelada";
  return "En proceso";
};
const stageToUi = (v) => ({ before:"Antes", during:"Durante", after:"Después" }[v] || v || "Durante");
const stageToDb = (v) => ({ "Antes":"before", "Durante":"during", "Después":"after" }[v] || "during");
const checkedData = (r, label) => {
  if (r.error) throw new Error((label ? label + ": " : "") + r.error.message);
  return r.data || [];
};
const byOrder = (rows) => rows.reduce((acc, row) => {
  (acc[row.work_order_id] ||= []).push(row);
  return acc;
}, {});

async function cargarSnapshot(extra) {
  const user = await requireSession();
  const pr = await CDB.from("profiles").select("user_id,full_name,role,active").eq("user_id", user.id).maybeSingle();
  if (pr.error) throw pr.error;
  if (!pr.data || !pr.data.active) throw new Error("Tu cuenta no está habilitada para Chewbbie Taller. Pide acceso a un administrador.");

  const admin = pr.data.role === "admin";
  const requests = await Promise.all([
    CDB.from("customers").select("*").order("full_name"),
    CDB.from("motorcycles").select("*").order("plate"),
    CDB.from("work_orders").select("*").order("created_at", { ascending:false }),
    CDB.from("work_order_items").select("*").order("created_at"),
    CDB.from("work_order_photos").select("*").order("created_at"),
    CDB.from("appointments").select("*").order("scheduled_at"),
    CDB.from("shop_settings").select("key,value")
  ]);
  const customers = checkedData(requests[0], "Clientes");
  const motorcycles = checkedData(requests[1], "Motocicletas");
  const orders = checkedData(requests[2], "Órdenes");
  const items = checkedData(requests[3], "Trabajos");
  const photos = checkedData(requests[4], "Fotografías");
  const appointments = checkedData(requests[5], "Agenda");
  const settings = checkedData(requests[6], "Configuración");

  let invoices = [], invoiceItems = [], team = [];
  if (admin) {
    const [ir, iir, tr] = await Promise.all([
      CDB.from("invoices").select("*").order("created_at", { ascending:false }),
      CDB.from("invoice_items").select("*"),
      SUPA.functions.invoke("chewbbie-team-admin", { body: { action:"list" } })
    ]);
    invoices = checkedData(ir, "Facturas");
    invoiceItems = checkedData(iir, "Detalle de facturas");
    if (tr.error) throw new Error(tr.data?.error || tr.error.message || "No se pudo cargar el equipo.");
    if (tr.data?.error) throw new Error(tr.data.error);
    team = tr.data?.team || [];
  } else {
    team = [{ user_id:user.id, email:user.email || "", full_name:pr.data.full_name, role:pr.data.role, active:true }];
  }

  const customerById = Object.fromEntries(customers.map(x => [x.id, x]));
  const motoById = Object.fromEntries(motorcycles.map(x => [x.id, x]));
  const invoiceByOrder = Object.fromEntries(invoices.map(x => [x.work_order_id, x]));
  const orderItems = byOrder(items);
  const invoiceItemsByInvoice = byOrder(invoiceItems.map(x => ({...x, work_order_id:x.invoice_id})));

  const mappedOrders = orders.map(o => {
    const its = orderItems[o.id] || [];
    const linkedInvoice = invoiceByOrder[o.id];
    const moto = motoById[o.motorcycle_id] || {};
    const customer = customerById[o.customer_id] || {};
    return {
      id:o.id, order_number:o.order_number, moto_id:o.motorcycle_id, cliente_id:o.customer_id,
      placa:moto.plate || "", marca:moto.make || "", modelo:moto.model || "",
      cliente_nombre:customer.full_name || "", cliente_telefono:customer.phone || "",
      ingreso:toIsoDate(o.received_at), motivo:o.complaint || "", estado:toUiStatus(o.status),
      trabajos:its.filter(x=>x.item_type==="labor").map(x=>({
        id:x.id, descripcion:x.description, precio:Number(x.unit_price)||0, hecho:!!x.is_completed,
        performed_by:x.performed_by || "", performed_by_name:x.performed_by_name || "", completed_at:x.completed_at || ""
      })),
      insumos:its.filter(x=>x.item_type==="supply").reduce((n,x)=>n+(Number(x.line_total)||Number(x.unit_price)||0),0),
      insumos_id:its.find(x=>x.item_type==="supply")?.id || "",
      repuestos:its.filter(x=>x.item_type==="part" || x.item_type==="other").map(x=>({id:x.id,nombre:x.description,precio:Number(x.unit_price)||0})),
      observaciones:o.diagnosis || o.work_performed || "", factura_id:linkedInvoice?.id || (o.status==="delivered" ? "__facturada__" : ""),
      assigned_to:o.assigned_to || "", actualizado_en:o.updated_at || o.created_at || ""
    };
  });

  const mappedInvoices = invoices.map(f => {
    const order = orders.find(o=>o.id===f.work_order_id) || {};
    const moto = motoById[order.motorcycle_id] || {};
    const customer = customerById[f.customer_id] || {};
    const its = invoiceItemsByInvoice[f.id] || [];
    return {
      id:f.id, numero:Number(String(f.invoice_number||"").match(/(\d+)$/)?.[1] || order.order_number || 0),
      fecha:toIsoDate(f.issued_at), moto_id:f.work_order_id, cliente_id:f.customer_id,
      placa:moto.plate || "", marca:moto.make || "", modelo:moto.model || "",
      cliente_nombre:customer.full_name || "", cliente_telefono:customer.phone || "",
      trabajos:its.filter(x=>x.item_type==="labor").map(x=>({descripcion:x.description,precio:Number(x.unit_price)||0})),
      insumos:its.filter(x=>x.item_type==="supply").reduce((n,x)=>n+(Number(x.line_total)||0),0),
      repuestos:its.filter(x=>x.item_type==="part" || x.item_type==="other").map(x=>({nombre:x.description,precio:Number(x.unit_price)||0})),
      total:Number(f.total)||0, invoice_number:f.invoice_number
    };
  });

  const mappedPhotos = photos.map(p=>({
    id:p.id, orden_id:p.work_order_id, etapa:stageToUi(p.stage), nombre:p.caption || "Evidencia",
    storage_path:p.storage_path, creado_en:p.created_at
  }));
  const mappedAppointments = appointments.map(a=>({
    id:a.id, customer_id:a.customer_id || "", motorcycle_id:a.motorcycle_id || "",
    customer_name:a.customer_name, customer_phone:a.customer_phone || "",
    scheduled_at:a.scheduled_at, estimated_minutes:a.estimated_minutes || 60,
    reason:a.reason || "", status:a.status, assigned_to:a.assigned_to || ""
  }));
  const cfg = {...CFG_DEF};
  settings.forEach(x => { cfg[x.key] = x.value; });
  return {
    clientes:customers.map(c=>({id:c.id,nombre:c.full_name,telefono:c.phone||"",email:c.email||"",address:c.address||"",notes:c.notes||""})),
    motos:motorcycles.map(m=>({id:m.id,cliente_id:m.customer_id,placa:m.plate,marca:m.make||"",modelo:m.model||"",year:m.model_year||"",mileage:m.mileage||0})),
    facturas:mappedInvoices, ordenes:mappedOrders, evidencias:mappedPhotos,
    citas:mappedAppointments, equipo:team, config:cfg,
    usuario:pr.data.full_name || user.email, usuario_id:user.id, email:user.email || "",
    rol:pr.data.role, extra:extra === undefined ? null : extra
  };
}

function aplicar(r) {
  S.clientes = r.clientes || [];
  S.motos = r.motos || [];
  S.facturas = r.facturas || [];
  S.ordenes = r.ordenes || [];
  S.evidencias = r.evidencias || [];
  S.citas = r.citas || [];
  S.equipo = r.equipo || [];
  S.config = {...CFG_DEF, ...(r.config || {})};
  S.usuario = r.usuario || S.usuario || "";
  S.usuario_id = r.usuario_id || S.usuario_id || "";
  S.email = r.email || S.email || "";
  S.rol = r.rol || S.rol || "worker";
  ULT = Date.now();
}
async function cargarDatos() { aplicar(await cargarSnapshot()); }
async function escribir(accion, datos) {
  const r = await api(accion, datos || {});
  if (r && r.clientes) aplicar(r);
  return r?.extra;
}

async function api(accion, d) {
  const user = await requireSession();
  const now = new Date().toISOString();
  let extra = null;

  if (accion === "cargar") return cargarSnapshot();
  if (accion === "salir") { await SUPA.auth.signOut(); return {}; }

  if (accion === "fotoVer") {
    const photo = unwrap(await CDB.from("work_order_photos").select("storage_path").eq("id", d.id).single(), "Foto");
    const signed = unwrap(await SUPA.storage.from("chewbbie-evidence").createSignedUrl(photo.storage_path, 300), "Enlace de foto");
    return { imagen:signed.signedUrl };
  }

  if (accion === "clienteGuardar") {
    if (d.id) {
      unwrap(await CDB.from("customers").update({full_name:d.nombre,phone:d.telefono||"",updated_by:user.id,updated_at:now}).eq("id",d.id), "Actualizar cliente");
    } else {
      const c = unwrap(await CDB.from("customers").insert({full_name:d.nombre,phone:d.telefono||"",created_by:user.id,updated_by:user.id}).select("id").single(), "Crear cliente");
      const plate = limpiarPlaca(d.placa);
      const m = await CDB.from("motorcycles").insert({customer_id:c.id,plate,make:d.marca,model:d.modelo,created_by:user.id,updated_by:user.id});
      if (m.error) { await CDB.from("customers").delete().eq("id",c.id); throw m.error; }
    }
  } else if (accion === "motoGuardar") {
    const payload = {plate:limpiarPlaca(d.placa),make:d.marca,model:d.modelo,updated_by:user.id,updated_at:now};
    if (d.id) unwrap(await CDB.from("motorcycles").update(payload).eq("id",d.id), "Actualizar moto");
    else unwrap(await CDB.from("motorcycles").insert({...payload,customer_id:d.cliente_id,created_by:user.id}), "Agregar moto");
  } else if (accion === "clienteEliminar") {
    exigirAdmin();
    const linked = unwrap(await CDB.from("motorcycles").select("id").eq("customer_id",d.id), "Consultar motos");
    if (linked.length) throw new Error("Este cliente tiene motocicletas registradas. Elimina o reasigna sus registros relacionados primero.");
    unwrap(await CDB.from("customers").delete().eq("id",d.id), "Eliminar cliente");
  } else if (accion === "motoEliminar") {
    exigirAdmin();
    const linked = unwrap(await CDB.from("work_orders").select("id").eq("motorcycle_id",d.id), "Consultar órdenes");
    if (linked.length) throw new Error("Esta moto tiene órdenes de trabajo. Conserva su historial y no la elimines.");
    unwrap(await CDB.from("motorcycles").delete().eq("id",d.id), "Eliminar moto");
  } else if (accion === "configGuardar") {
    exigirAdmin();
    const rows = Object.keys(d).map(key=>({key,value:String(d[key] ?? ""),updated_by:user.id,updated_at:now}));
    if (rows.length) unwrap(await CDB.from("shop_settings").upsert(rows,{onConflict:"key"}), "Guardar configuración");
  } else if (accion === "ordenGuardar") {
    const plate = limpiarPlaca(d.placa);
    let moto = unwrap(await CDB.from("motorcycles").select("*").eq("plate",plate).maybeSingle(), "Buscar motocicleta");
    let customer = null;
    if (moto) {
      customer = unwrap(await CDB.from("customers").select("*").eq("id",moto.customer_id).single(), "Buscar cliente");
    } else {
      customer = unwrap(await CDB.from("customers").insert({
        full_name:d.cliente_nombre,phone:d.cliente_telefono||"",created_by:user.id,updated_by:user.id
      }).select("*").single(), "Crear cliente");
      moto = unwrap(await CDB.from("motorcycles").insert({
        customer_id:customer.id,plate,make:d.marca,model:d.modelo,created_by:user.id,updated_by:user.id
      }).select("*").single(), "Crear motocicleta");
    }

    let previous = null;
    if (d.id) previous = unwrap(await CDB.from("work_orders").select("*").eq("id",d.id).single(), "Consultar orden");
    if (previous?.status === "delivered") throw new Error("Esta orden ya fue facturada y no se puede modificar.");
    const payload = {
      customer_id:customer.id, motorcycle_id:moto.id, complaint:d.motivo||"",
      diagnosis:d.observaciones||"", status:toDbStatus(d.estado),
      received_at:new Date((d.ingreso || hoyISO())+"T12:00:00-05:00").toISOString(),
      assigned_to:d.assigned_to || null, updated_by:user.id, updated_at:now
    };
    let order;
    if (previous) order = unwrap(await CDB.from("work_orders").update(payload).eq("id",d.id).select("*").single(), "Actualizar orden");
    else order = unwrap(await CDB.from("work_orders").insert({...payload,created_by:user.id}).select("*").single(), "Crear orden");

    const itemRows = [];
    (d.trabajos||[]).forEach(t=>{
      if (!String(t.descripcion||"").trim()) return;
      itemRows.push({
        id:t.id || crypto.randomUUID(), work_order_id:order.id, item_type:"labor",
        description:String(t.descripcion).trim(), quantity:1, unit_price:Math.max(0,Number(t.precio)||0),
        is_completed:!!t.hecho, performed_by:t.hecho?(t.performed_by||user.id):null,
        performed_by_name:t.hecho?(t.performed_by_name||S.usuario):null,
        completed_at:t.hecho?(t.completed_at||now):null, created_by:user.id
      });
    });
    (d.repuestos||[]).forEach(t=>{
      if (!String(t.nombre||"").trim()) return;
      itemRows.push({
        id:t.id || crypto.randomUUID(), work_order_id:order.id, item_type:"part",
        description:String(t.nombre).trim(), quantity:1, unit_price:Math.max(0,Number(t.precio)||0), created_by:user.id
      });
    });
    itemRows.push({
      id:(d.insumos_id || d._supply_id || crypto.randomUUID()), work_order_id:order.id, item_type:"supply",
      description:"Insumos", quantity:1, unit_price:Math.max(0,Number(d.insumos)||0), created_by:user.id
    });
    unwrap(await CDB.from("work_order_items").upsert(itemRows,{onConflict:"id"}), "Guardar trabajos de la orden");
    extra = {orden_id:order.id};
  } else if (accion === "ordenFacturar") {
    exigirAdmin();
    const order = unwrap(await CDB.from("work_orders").select("*").eq("id",d.id).single(), "Consultar orden");
    if (order.status === "delivered") throw new Error("Esta orden ya está facturada.");
    if (order.status !== "ready") throw new Error("Primero marca la orden como Finalizada y guarda los cambios.");
    const rows = unwrap(await CDB.from("work_order_items").select("*").eq("work_order_id",order.id), "Consultar trabajos");
    const labor = rows.filter(x=>x.item_type==="labor" && x.is_completed);
    const parts = rows.filter(x=>x.item_type==="part" || x.item_type==="other");
    const supplies = rows.filter(x=>x.item_type==="supply");
    if (!labor.length) throw new Error("Marca al menos un trabajo como realizado antes de facturar.");
    const all = labor.concat(parts,supplies);
    const subtotal = all.reduce((n,x)=>n+(Number(x.quantity)||1)*(Number(x.unit_price)||0),0);
    const invoiceNumber = "CH-" + String(order.order_number).padStart(5,"0");
    const invoice = unwrap(await CDB.from("invoices").insert({
      invoice_number:invoiceNumber,work_order_id:order.id,customer_id:order.customer_id,
      issued_at:new Date((d.fecha||hoyISO())+"T12:00:00-05:00").toISOString(),
      status:"issued",subtotal,discount:0,tax:0,total:subtotal,created_by:user.id,updated_by:user.id
    }).select("*").single(), "Crear factura");
    const lineRows = all.map(x=>({
      invoice_id:invoice.id,item_type:x.item_type,description:x.description,
      quantity:x.quantity||1,unit_price:x.unit_price||0
    }));
    const lineResult = await CDB.from("invoice_items").insert(lineRows);
    if (lineResult.error) {
      await CDB.from("invoices").delete().eq("id",invoice.id);
      throw lineResult.error;
    }
    unwrap(await CDB.from("work_orders").update({status:"delivered",delivered_at:now,updated_by:user.id,updated_at:now}).eq("id",order.id), "Cerrar orden");
    extra = {factura_id:invoice.id};
  } else if (accion === "facturaGuardar") {
    throw new Error("Las facturas se generan desde una orden de trabajo finalizada para evitar duplicar información.");
  } else if (accion === "facturaEliminar") {
    exigirAdmin();
    const inv = unwrap(await CDB.from("invoices").select("id,work_order_id").eq("id",d.id).single(), "Consultar factura");
    unwrap(await CDB.from("invoice_items").delete().eq("invoice_id",inv.id), "Eliminar detalle");
    unwrap(await CDB.from("invoices").delete().eq("id",inv.id), "Eliminar factura");
    await CDB.from("work_orders").update({status:"ready",delivered_at:null,updated_by:user.id,updated_at:now}).eq("id",inv.work_order_id);
  } else if (accion === "fotoGuardar") {
    const match = String(d.imagen||"").match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error("No se pudo leer la imagen. Usa JPG, PNG o WebP.");
    const bytes = Uint8Array.from(atob(match[2]), c=>c.charCodeAt(0));
    const mime = "image/" + match[1];
    const blob = new Blob([bytes],{type:mime});
    const path = d.orden_id + "/" + crypto.randomUUID() + "." + (match[1]==="jpeg"?"jpg":match[1]);
    const uploaded = await SUPA.storage.from("chewbbie-evidence").upload(path,blob,{contentType:mime,upsert:false});
    if (uploaded.error) throw uploaded.error;
    const saved = await CDB.from("work_order_photos").insert({
      work_order_id:d.orden_id,storage_path:path,stage:stageToDb(d.etapa),
      caption:String(d.nombre||"Evidencia").slice(0,200),uploaded_by:user.id
    });
    if (saved.error) {
      await SUPA.storage.from("chewbbie-evidence").remove([path]);
      throw saved.error;
    }
  } else if (accion === "fotoEliminar") {
    exigirAdmin();
    const photo = unwrap(await CDB.from("work_order_photos").select("id,storage_path").eq("id",d.id).single(), "Consultar evidencia");
    const removed = await SUPA.storage.from("chewbbie-evidence").remove([photo.storage_path]);
    if (removed.error) throw removed.error;
    unwrap(await CDB.from("work_order_photos").delete().eq("id",photo.id), "Eliminar evidencia");
  } else if (accion === "citaGuardar") {
    const payload = {
      customer_id:d.customer_id || null, motorcycle_id:d.motorcycle_id || null,
      customer_name:String(d.customer_name||"").trim(), customer_phone:String(d.customer_phone||"").trim(),
      scheduled_at:new Date(d.scheduled_at).toISOString(), estimated_minutes:Math.max(15,Number(d.estimated_minutes)||60),
      reason:String(d.reason||"").trim(), assigned_to:d.assigned_to || null,
      status:d.status || "scheduled", updated_by:user.id
    };
    if (!payload.customer_name) throw new Error("Escribe el nombre del cliente.");
    if (!payload.reason) throw new Error("Indica el motivo de la cita.");
    if (d.id) unwrap(await CDB.from("appointments").update(payload).eq("id",d.id), "Actualizar cita");
    else unwrap(await CDB.from("appointments").insert({...payload,created_by:user.id}), "Agendar cita");
  } else if (accion === "citaEstado") {
    unwrap(await CDB.from("appointments").update({status:d.status,updated_by:user.id,updated_at:now}).eq("id",d.id), "Actualizar estado de cita");
  } else if (accion === "teamCreate") {
    exigirAdmin();
    const result = await SUPA.functions.invoke("chewbbie-team-admin",{body:{action:"create",email:d.email,full_name:d.full_name,role:d.role}});
    if (result.error) throw new Error(result.data?.error || result.error.message);
    if (result.data?.error) throw new Error(result.data.error);
    extra = {miembro:result.data?.user || null};
  } else if (accion === "teamUpdate") {
    exigirAdmin();
    const result = await SUPA.functions.invoke("chewbbie-team-admin",{body:{action:"update",user_id:d.user_id,role:d.role,active:d.active,full_name:d.full_name}});
    if (result.error) throw new Error(result.data?.error || result.error.message);
    if (result.data?.error) throw new Error(result.data.error);
    extra = {miembro:result.data?.profile || null};
  } else if (accion === "registrosEliminar") {
    exigirAdmin();
    const orderIds = new Set(d.ordenIds||[]);
    const invoiceIds = new Set(d.facturaIds||[]);
    const customerIds = new Set(d.clienteIds||[]);
    const motos = customerIds.size ? unwrap(await CDB.from("motorcycles").select("id").in("customer_id",[...customerIds]),"Buscar motos") : [];
    const motoIds = new Set(motos.map(x=>x.id));
    const appointmentIds = new Set();
    if (customerIds.size) {
      const os = unwrap(await CDB.from("work_orders").select("id").in("customer_id",[...customerIds]),"Buscar órdenes del cliente");
      os.forEach(x=>orderIds.add(x.id));
      const inv = unwrap(await CDB.from("invoices").select("id").in("customer_id",[...customerIds]),"Buscar facturas relacionadas");
      inv.forEach(x=>invoiceIds.add(x.id));
      const aps = unwrap(await CDB.from("appointments").select("id").in("customer_id",[...customerIds]),"Buscar citas del cliente");
      aps.forEach(x=>appointmentIds.add(x.id));
    }
    if (motoIds.size) {
      const os = unwrap(await CDB.from("work_orders").select("id").in("motorcycle_id",[...motoIds]),"Buscar órdenes de las motos");
      os.forEach(x=>orderIds.add(x.id));
      const aps = unwrap(await CDB.from("appointments").select("id").in("motorcycle_id",[...motoIds]),"Buscar citas de las motos");
      aps.forEach(x=>appointmentIds.add(x.id));
    }
    if (orderIds.size) {
      const inv = unwrap(await CDB.from("invoices").select("id").in("work_order_id",[...orderIds]),"Buscar facturas de órdenes");
      inv.forEach(x=>invoiceIds.add(x.id));
    }
    const photos = orderIds.size ? unwrap(await CDB.from("work_order_photos").select("id,storage_path").in("work_order_id",[...orderIds]),"Buscar fotos") : [];
    if (photos.length) {
      const rm = await SUPA.storage.from("chewbbie-evidence").remove(photos.map(x=>x.storage_path));
      if (rm.error) throw rm.error;
      unwrap(await CDB.from("work_order_photos").delete().in("id",photos.map(x=>x.id)),"Eliminar fotos");
    }
    if (invoiceIds.size) {
      unwrap(await CDB.from("invoice_items").delete().in("invoice_id",[...invoiceIds]),"Eliminar líneas de factura");
      unwrap(await CDB.from("invoices").delete().in("id",[...invoiceIds]),"Eliminar facturas");
    }
    if (appointmentIds.size) unwrap(await CDB.from("appointments").delete().in("id",[...appointmentIds]),"Eliminar citas");
    if (orderIds.size) {
      unwrap(await CDB.from("work_order_items").delete().in("work_order_id",[...orderIds]),"Eliminar trabajos");
      unwrap(await CDB.from("work_orders").delete().in("id",[...orderIds]),"Eliminar órdenes");
    }
    if (motoIds.size) unwrap(await CDB.from("motorcycles").delete().in("id",[...motoIds]),"Eliminar motos");
    if (customerIds.size) unwrap(await CDB.from("customers").delete().in("id",[...customerIds]),"Eliminar clientes");
    extra = {ordenes:orderIds.size,facturas:invoiceIds.size};
  } else {
    throw new Error("Acción no reconocida: " + accion);
  }

  return cargarSnapshot(extra);
}

async function entrar(ev) {
  ev.preventDefault();
  const email = $("#lg-email").value.trim().toLowerCase();
  const button = $("#lg-btn");
  const error = $("#lg-err");
  error.textContent = "";
  if (!email) { error.textContent = "Escribe tu correo."; return; }
  button.disabled = true;
  try {
    const result = await SUPA.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://jguerreroflorido.github.io/chewbbie-taller/"
      }
    });
    if (result.error) throw result.error;
    $("#lg-hint").textContent = "Enviamos un enlace a " + email + ". Abre ese correo y pulsa el enlace para entrar. No necesitas contraseña.";
    $("#lg-resend").classList.remove("hidden");
    $("#lg-change").classList.remove("hidden");
    button.textContent = "Enviar otro enlace";
  } catch (e) {
    error.textContent = e.message || "No se pudo enviar el enlace de acceso.";
  } finally {
    button.disabled = false;
  }
}
async function reenviarCodigo() {
  const email = $("#lg-email").value.trim().toLowerCase();
  if (!email) return;
  const r = await SUPA.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: "https://jguerreroflorido.github.io/chewbbie-taller/"
    }
  });
  $("#lg-err").textContent = r.error ? r.error.message : "Enviamos otro enlace a tu correo.";
}
function reiniciarAcceso() {
  $("#lg-resend").classList.add("hidden");
  $("#lg-change").classList.add("hidden");
  $("#lg-hint").textContent = "Escribe tu correo autorizado. Te enviaremos un enlace para entrar.";
  $("#lg-btn").textContent = "Enviar enlace de acceso";
  $("#lg-err").textContent = "";
}
function mostrarLogin(msg) {
  ACTIVA = false;
  cerrarModal(true);
  $("#aviso-pantalla").classList.add("hidden");
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#lg-err").textContent = msg || "";
  document.querySelectorAll(".logo-img").forEach(i=>i.src=LOGO_DEFECTO);
  if (!msg) reiniciarAcceso();
}
function mostrarApp() {
  $("#aviso-pantalla").classList.add("hidden");
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  aplicarMarca();
  render();
}
async function entrarApp() {
  try {
    await cargarDatos();
    ACTIVA = true;
    $("#usuario-side").textContent = S.usuario + " · " + (esAdmin()?"Administrador":"Trabajador");
    mostrarApp();
  } catch (e) {
    await SUPA.auth.signOut();
    TOKEN = "";
    mostrarLogin(e.message || "No se pudo abrir Chewbbie Taller.");
  }
}
async function salir() {
  await SUPA.auth.signOut();
  TOKEN = "";
  S.clientes=[]; S.motos=[]; S.facturas=[]; S.ordenes=[]; S.evidencias=[]; S.citas=[]; S.equipo=[];
  S.config={...CFG_DEF}; S.usuario=""; S.usuario_id=""; S.rol="";
  mostrarLogin();
}
async function iniciar() {
  document.querySelectorAll(".logo-img").forEach(i=>i.src=LOGO_DEFECTO);
  const r = await SUPA.auth.getSession();
  if (r.data?.session) {
    TOKEN = r.data.session.access_token;
    await entrarApp();
  } else mostrarLogin();
}

const MENU_CHEWBBIE = [
  ["inicio","Inicio","M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"],
  ["ordenes","Órdenes","M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7"],
  ["clientes","Clientes","M9 4.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6M16 4.5a3.5 3.5 0 010 7M18 14.5c2 .7 3.5 2.6 3.5 5.5"],
  ["agenda","Agenda","M7 2v4M17 2v4M3 9h18M5 4h14a2 2 0 012 2v14H3V6a2 2 0 012-2zM7 13h3M7 17h3"],
  ["historial","Facturas","M8 3h8l4 4v14H4V3zM8 12h8M8 16h8M15 3v5h5"],
  ["equipo","Equipo","M16 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M10 11a4 4 0 100-8 4 4 0 000 8zM20 8v6M17 11h6"],
  ["config","Configuración","M4 7h10M18 7h2M4 17h2M10 17h10M16 5a2 2 0 100 4 2 2 0 000-4zM8 15a2 2 0 100 4 2 2 0 000-4z"]
];
function pintarMenus() {
  const allowed = MENU_CHEWBBIE.filter(x=>esAdmin() || !["historial","equipo","config"].includes(x[0]));
  const html = allowed.map(x=>'<button class="'+(x[0]===vista?'on':'')+'" onclick="ir(\''+x[0]+'\')"><svg class="ico" viewBox="0 0 24 24"><path d="'+x[2]+'"/></svg><span>'+x[1]+'</span></button>').join("");
  $("#menu-side").innerHTML = html;
  $("#menu-bottom").innerHTML = html;
}
function ir(v) {
  if (["historial","equipo","config"].includes(v) && !esAdmin()) { toast("No tienes permiso para entrar en esta sección."); return; }
  if (v==="nueva" && vista!=="nueva") F=nuevaEstado();
  else if (v==="nueva" && F && F.id) F=nuevaEstado();
  vista=v; render(); window.scrollTo(0,0);
}
function render() {
  pintarMenus();
  const views = {inicio:vInicio,ordenes:vOrdenes,clientes:vClientes,nueva:vNueva,historial:vHistorial,config:vConfig,agenda:vAgenda,equipo:vEquipo};
  $("#vista").innerHTML = (views[vista] || vInicio)();
  if (vista==="clientes") pintarClientes();
  if (vista==="ordenes") pintarOrdenes();
  if (vista==="historial") pintarHistorial();
  if (vista==="nueva") { pintarPlaca(); pintarTrabajos(); pintarInsumos(); pintarRep(); calcTotal(); }
  if (vista==="agenda") pintarAgenda();
  if (vista==="equipo") pintarEquipo();
}
function vInicio() {
  const today = hoyISO();
  const pending = S.ordenes.filter(o=>o.estado!=="Finalizada" && o.estado!=="Cancelada").length;
  const todayAppointments = S.citas.filter(c=>localISODate(c.scheduled_at)===today && c.status!=="cancelled").length;
  const cards = '<div class="g3">'+stat("Órdenes activas",pending)+stat("Citas de hoy",todayAppointments)+stat("Clientes registrados",S.clientes.length)+'</div>';
  const next = S.citas.filter(c=>new Date(c.scheduled_at)>=new Date() && c.status!=="cancelled").sort((a,b)=>new Date(a.scheduled_at)-new Date(b.scheduled_at)).slice(0,5);
  const appt = '<div class="card"><h2>Próximas citas</h2>'+(next.length?next.map(c=>'<div class="fila" onclick="ir(\'agenda\')"><div><b>'+esc(c.customer_name)+'</b><div class="mut">'+new Date(c.scheduled_at).toLocaleString("es-CO")+' · '+esc(c.reason)+'</div></div><span class="badge">'+esc(c.status)+'</span></div>').join(""):'<p class="mut">No hay citas próximas.</p>')+'</div>';
  const latest = S.ordenes.slice(0,5).map(o=>'<div class="fila" onclick="abrirOrden(\''+o.id+'\')"><div><b><span class="placa sm">'+esc(o.placa)+'</span> '+esc(o.cliente_nombre)+'</b><div class="mut">'+esc(o.marca)+' '+esc(o.modelo)+' · '+fechaCorta(o.ingreso)+'</div></div><span>'+esc(o.estado)+'</span></div>').join("");
  const inv = esAdmin() ? '<div class="card"><h2>Facturación</h2><div class="g2">'+stat("Facturas",S.facturas.length)+stat("Total acumulado",pesos(sumar(S.facturas,"total")))+'</div><button class="btn sec sm" onclick="ir(\'historial\')">Ver historial de facturas</button></div>' : "";
  return '<div class="cab"><h1>Inicio</h1><button class="btn" onclick="abrirOrden()">+ Recibir motocicleta</button></div>'+cards+appt+'<div class="card"><h2>Órdenes recientes</h2>'+(latest||'<p class="mut">Todavía no hay órdenes.</p>')+'</div>'+inv;
}
function vOrdenes() {
  return '<div class="cab"><h1>Órdenes de trabajo</h1><button class="btn" onclick="abrirOrden()">+ Recibir motocicleta</button></div><p class="mut">Registra el diagnóstico, los trabajos, repuestos, responsables y evidencias de cada motocicleta.</p><input class="mt" placeholder="Buscar placa o cliente" value="'+esc(QO)+'" oninput="QO=this.value;pintarOrdenes()"><div id="ordenes-lista" class="mt"></div>';
}
function pintarOrdenes() {
  const box=$("#ordenes-lista"); if(!box)return;
  const f=QO.toLowerCase();
  const rows=S.ordenes.filter(o=>(o.placa+" "+o.cliente_nombre+" "+o.marca+" "+o.modelo).toLowerCase().includes(f));
  box.innerHTML=rows.length?rows.map(o=>{
    const done=(o.trabajos||[]).filter(t=>t.hecho).length;
    const actions='<button class="btn sec sm" onclick="abrirOrden(\''+o.id+'\')">'+(o.factura_id?"Ver orden":"Continuar")+'</button>'+
      (esAdmin()&&o.factura_id&&o.factura_id!=="__facturada__"?'<button class="btn sm" onclick="abrirFacturaOrden(\''+o.factura_id+'\')">Ver factura</button>':"")+
      (esAdmin()&&!o.factura_id&&o.estado==="Finalizada"?'<button class="btn sm" onclick="facturarDesdeLista(\''+o.id+'\')">Generar factura</button>':"")+
      (esAdmin()?'<button class="btn red sm" onclick="eliminarUnaOrden(\''+o.id+'\')">Eliminar</button>':"");
    return '<div class="card cab2"><div><span class="placa">'+esc(o.placa)+'</span> <b>'+esc(o.marca)+' '+esc(o.modelo)+'</b><div class="mut">'+esc(o.cliente_nombre)+' · '+fechaCorta(o.ingreso)+' · '+esc(o.estado)+'</div><div class="mut">'+esc(o.motivo||"Sin motivo reportado")+'</div><div class="mut">'+done+'/'+(o.trabajos||[]).length+' trabajos marcados como realizados</div></div><div class="bt">'+actions+'</div></div>';
  }).join(""):'<div class="card vacio">Aún no hay órdenes para esta búsqueda.</div>';
}
function vClientes() {
  return '<div class="cab"><h1>Clientes y motos</h1><button class="btn" onclick="abrirOrden()">+ Recibir motocicleta</button></div><p class="mut">Consulta las órdenes, los trabajos realizados y las evidencias de cada motocicleta.</p><input id="q-cli" placeholder="Buscar por placa, nombre o teléfono" value="'+esc(qCli)+'" oninput="qCli=this.value;pintarClientes()"><div class="mt" id="lista-cli"></div>';
}
function vAgenda() {
  return '<div class="cab"><h1>Agenda de citas</h1><button class="btn" onclick="abrirCita()">+ Agendar cita</button></div><p class="mut">Programa clientes para diagnóstico, programación ECU, reprogramación, alarmas y otros servicios.</p><div class="g2"><div><label>Ver fecha</label><input type="date" value="'+esc(AGENDA_FECHA)+'" onchange="AGENDA_FECHA=this.value;pintarAgenda()"></div><div style="display:flex;align-items:end"><button class="btn sec" onclick="AGENDA_FECHA=hoyISO();pintarAgenda()">Hoy</button></div></div><div id="agenda-lista" class="mt"></div>';
}
function pintarAgenda() {
  const box=$("#agenda-lista"); if(!box)return;
  const rows=S.citas.filter(c=>localISODate(c.scheduled_at)===AGENDA_FECHA).sort((a,b)=>new Date(a.scheduled_at)-new Date(b.scheduled_at));
  box.innerHTML=rows.length?rows.map(c=>{
    const date=new Date(c.scheduled_at);
    const statusLabel=({scheduled:"Programada",confirmed:"Confirmada",arrived:"En el taller",completed:"Atendida",cancelled:"Cancelada",no_show:"No asistió"})[c.status]||c.status;
    const worker=S.equipo.find(x=>x.user_id===c.assigned_to);
    return '<div class="card cab2"><div><div class="nom">'+date.toLocaleTimeString("es-CO",{hour:"2-digit",minute:"2-digit"})+' · '+esc(c.customer_name)+'</div><div class="mut">'+esc(c.customer_phone||"Sin teléfono")+' · '+Number(c.estimated_minutes||60)+' min</div><div>'+esc(c.reason)+'</div><div class="mut">'+(worker?'Responsable: '+esc(worker.full_name):"Sin responsable asignado")+' · '+statusLabel+'</div></div><div class="bt"><button class="btn sec sm" onclick="abrirCita(\''+c.id+'\')">Editar</button>'+(c.status!=="confirmed"&&c.status!=="completed"&&c.status!=="cancelled"?'<button class="btn sm" onclick="cambiarEstadoCita(\''+c.id+'\',\'confirmed\')">Confirmar</button>':"")+(c.status!=="completed"&&c.status!=="cancelled"?'<button class="btn sec sm" onclick="cambiarEstadoCita(\''+c.id+'\',\'completed\')">Atendida</button>':"")+(c.status!=="cancelled"&&c.status!=="completed"?'<button class="btn red sm" onclick="cambiarEstadoCita(\''+c.id+'\',\'cancelled\')">Cancelar</button>':"")+'</div></div>';
  }).join(""):'<div class="card vacio">No hay citas para esta fecha.</div>';
}
function abrirCita(id) {
  const old=id?S.citas.find(x=>x.id===id):null;
  CITA_ACTUAL=old?{...old}:{customer_id:"",motorcycle_id:"",customer_name:"",customer_phone:"",scheduled_at:dateInputLocal(new Date()),estimated_minutes:60,reason:"",status:"scheduled",assigned_to:esAdmin()?"":S.usuario_id};
  const options=S.clientes.map(c=>'<option value="'+c.id+'" '+(CITA_ACTUAL.customer_id===c.id?'selected':'')+'>'+esc(c.nombre)+'</option>').join("");
  const staff=(S.equipo.length?S.equipo:[{user_id:S.usuario_id,full_name:S.usuario}]).filter(x=>x.active!==false).map(x=>'<option value="'+x.user_id+'" '+(CITA_ACTUAL.assigned_to===x.user_id?'selected':'')+'>'+esc(x.full_name)+'</option>').join("");
  abrirModal(old?"Editar cita":"Agendar cita",'<div class="sub"><div><label>Cliente registrado (opcional)</label><select id="ag-cliente" onchange="seleccionarClienteCita(this.value)"><option value="">Cliente nuevo / sin ficha</option>'+options+'</select></div><div><label>Nombre del cliente *</label><input id="ag-nombre" value="'+esc(CITA_ACTUAL.customer_name)+'"></div><div class="g2"><div><label>Teléfono</label><input id="ag-telefono" value="'+esc(CITA_ACTUAL.customer_phone)+'"></div><div><label>Fecha y hora *</label><input id="ag-fecha" type="datetime-local" value="'+esc(dateInputLocal(CITA_ACTUAL.scheduled_at))+'"></div></div><div class="g2"><div><label>Duración estimada (minutos)</label><input id="ag-duracion" type="number" min="15" step="15" value="'+Number(CITA_ACTUAL.estimated_minutes||60)+'"></div><div><label>Responsable</label><select id="ag-responsable">'+staff+'</select></div></div><label>Motivo / servicio *</label><input id="ag-motivo" list="ag-servicios" value="'+esc(CITA_ACTUAL.reason)+'" placeholder="Ej. Programación ECU, reprogramación, alarma..."><datalist id="ag-servicios"><option>Programación ECU</option><option>Reprogramación ECU</option><option>Instalación de alarma</option><option>Mantenimiento</option><option>Diagnóstico</option><option>Revisión general</option></datalist><p class="err" id="ag-error"></p><div class="acc"><button class="btn sec" onclick="cerrarModal()">Cerrar</button><button class="btn" onclick="guardarCitaUI()">'+(old?"Guardar cambios":"Agendar cita")+'</button></div></div>');
}
function seleccionarClienteCita(id) {
  const c=S.clientes.find(x=>x.id===id); if(!c)return;
  $("#ag-nombre").value=c.nombre; $("#ag-telefono").value=c.telefono||"";
  CITA_ACTUAL.customer_id=id;
}
async function guardarCitaUI() {
  const error=$("#ag-error");
  const data={
    id:CITA_ACTUAL.id||undefined,customer_id:$("#ag-cliente").value||null,
    customer_name:$("#ag-nombre").value.trim(),customer_phone:$("#ag-telefono").value.trim(),
    scheduled_at:$("#ag-fecha").value,estimated_minutes:$("#ag-duracion").value,
    assigned_to:$("#ag-responsable").value||null,reason:$("#ag-motivo").value.trim(),
    status:CITA_ACTUAL.status||"scheduled"
  };
  if(!data.scheduled_at){error.textContent="Elige la fecha y hora de la cita.";return;}
  try { await escribir("citaGuardar",data); cerrarModal(); render(); toast("Cita guardada."); }
  catch(e){error.textContent=e.message||"No se pudo guardar la cita.";}
}
async function cambiarEstadoCita(id,status) {
  try { await escribir("citaEstado",{id,status}); pintarAgenda(); toast("Estado de la cita actualizado."); }
  catch(e){toast(e.message||"No se pudo actualizar.");}
}
function vEquipo() {
  if(!esAdmin()) return '<div class="card vacio">Solo los administradores pueden gestionar el equipo.</div>';
  return '<div class="cab"><h1>Equipo de trabajo</h1><button class="btn" onclick="abrirNuevoMiembro()">+ Agregar persona</button></div><p class="mut">Agrega a cada persona con su correo y define su permiso. No necesita crear una contraseña: entrará con un código enviado a su correo.</p><div id="equipo-lista"></div>';
}
function pintarEquipo() {
  const box=$("#equipo-lista"); if(!box)return;
  box.innerHTML=S.equipo.length?S.equipo.map(x=>'<div class="card cab2"><div><div class="nom">'+esc(x.full_name)+'</div><div class="mut">'+esc(x.email)+'</div><div class="mut">'+(x.active?'Activo':'Acceso desactivado')+' · '+(x.role==="admin"?"Administrador":"Trabajador")+'</div></div><div class="bt"><select aria-label="Permiso de '+esc(x.full_name)+'" onchange="actualizarMiembro(\''+x.user_id+'\',{role:this.value})"><option value="worker" '+(x.role==="worker"?"selected":"")+'>Trabajador</option><option value="admin" '+(x.role==="admin"?"selected":"")+'>Administrador</option></select><button class="btn '+(x.active?'red':'sec')+' sm" onclick="actualizarMiembro(\''+x.user_id+'\',{active:'+(!x.active)+ '})">'+(x.active?'Desactivar':'Activar')+'</button></div></div>').join(""):'<div class="card vacio">Todavía no hay personas agregadas.</div>';
}
function abrirNuevoMiembro() {
  abrirModal("Agregar persona al equipo",'<div class="sub"><label>Nombre completo *</label><input id="eq-nombre" placeholder="Nombre de la persona"><label>Correo electrónico *</label><input id="eq-email" type="email" placeholder="persona@correo.com"><label>Permiso</label><select id="eq-rol"><option value="worker">Trabajador</option><option value="admin">Administrador</option></select><p class="mut">La persona no tendrá que crear una contraseña. Su correo quedará autorizado y podrá solicitar un código de acceso.</p><p class="err" id="eq-error"></p><div class="acc"><button class="btn sec" onclick="cerrarModal()">Cancelar</button><button class="btn" onclick="guardarMiembro()">Agregar al equipo</button></div></div>');
}
async function guardarMiembro() {
  const error=$("#eq-error");
  try {
    await escribir("teamCreate",{full_name:$("#eq-nombre").value.trim(),email:$("#eq-email").value.trim(),role:$("#eq-rol").value});
    cerrarModal(); render(); toast("Persona agregada. Ya puede entrar con su correo.");
  } catch(e){error.textContent=e.message||"No se pudo agregar la persona.";}
}
async function actualizarMiembro(user_id,patch) {
  try { await escribir("teamUpdate",{user_id,...patch}); pintarEquipo(); toast("Permisos actualizados."); }
  catch(e){toast(e.message||"No se pudo actualizar el equipo.");}
}
function tarjetaCliente(c) {
  const ms=motosDe(c.id);
  return '<div class="card"><div class="cab2"><div><div class="nom">'+esc(c.nombre)+'</div><div class="mut">'+esc(c.telefono)||'Sin teléfono'+'</div></div><div class="bt"><button class="btn sec sm" onclick="modalCliente(\''+c.id+'\')">Editar</button><button class="btn sec sm" onclick="modalMoto(\''+c.id+'\')">+ Moto</button>'+(esAdmin()?'<button class="btn red sm" onclick="eliminarCliente(\''+c.id+'\')">Eliminar</button>':"")+'</div></div>'+(ms.length?ms.map(bloqueMoto).join(""):'<p class="mut">Sin motos registradas.</p>')+'</div>';
}
function bloqueMoto(m) {
  const placa=limpiarPlaca(m.placa), abierta=ABIERTAS.has(placa);
  const orders=ordenesDePlaca(placa);
  const invoices=esAdmin()?facturasDePlaca(placa):[];
  const detail=abierta?'<div class="serv" style="padding:12px"><h2>Órdenes de trabajo ('+orders.length+')</h2>'+(orders.map(o=>{
    const done=(o.trabajos||[]).filter(t=>t.hecho);
    const pending=(o.trabajos||[]).filter(t=>!t.hecho);
    return '<div class="card" style="margin:10px 0;padding:12px"><div class="cab2"><div><b>Orden '+fechaCorta(o.ingreso)+'</b> · '+esc(o.estado)+'<div class="mut">'+esc(o.motivo||"Sin motivo reportado")+'</div></div><button class="btn sec sm" onclick="abrirOrden(\''+o.id+'\')">Ver orden y fotos ('+S.evidencias.filter(p=>p.orden_id===o.id).length+')</button></div>'+(done.length?'<div class="mut mt"><b>Trabajos realizados</b></div>'+done.map(t=>'<div class="fl"><span>'+esc(t.descripcion)+' <small class="mut">· '+esc(t.performed_by_name||"Responsable no indicado")+'</small></span><span>'+pesos(t.precio)+'</span></div>').join(""):'<div class="mut mt">Sin trabajos marcados como realizados.</div>')+(pending.length?'<div class="mut mt">Pendientes: '+esc(pending.map(t=>t.descripcion).join(", "))+'</div>':"")+(o.factura_id&&esAdmin()?'<button class="btn sm mt" onclick="abrirFacturaOrden(\''+o.factura_id+'\')">Ver factura</button>':(!o.factura_id&&o.estado==="Finalizada"&&esAdmin()?'<button class="btn sm mt" onclick="facturarDesdeLista(\''+o.id+'\')">Generar factura</button>':""))+'</div>';
  }).join("")||'<p class="mut">Sin órdenes para esta placa.</p>')+'<h2 class="mt">Facturas anteriores ('+invoices.length+')</h2>'+(invoices.map(f=>'<div class="fila" onclick="verFactura(\''+f.id+'\')"><div><b>Factura #'+num4(f.numero)+'</b> · '+fechaCorta(f.fecha)+'</div><span class="monto">'+pesos(f.total)+'</span></div>').join("")||'<p class="mut">Todavía no hay facturas.</p>')+'</div>':"";
  return '<div class="moto"><div class="cab2"><div><span class="placa">'+esc(placa)+'</span> <b>'+esc(m.marca)+' '+esc(m.modelo)+'</b><div class="mut">'+orders.length+' órdenes · '+invoices.length+' facturas</div></div><div class="bt"><button class="btn sec sm" onclick="alternarServicios(\''+esc(placa)+'\')">'+(abierta?'Ocultar historial':'Ver historial')+'</button><button class="btn sm" onclick="abrirOrdenParaPlaca(\''+esc(placa)+'\')">+ Orden</button><button class="btn sec sm" onclick="modalMoto(\''+m.cliente_id+'\',\''+m.id+'\')">Editar</button>'+(esAdmin()?'<button class="btn red sm" onclick="eliminarMoto(\''+m.id+'\')">Eliminar</button>':"")+'</div></div>'+detail+'</div>';
}
function lineaOrdenTrabajo(i,t,read) {
  const who=t.hecho ? ('Realizado por: '+(t.performed_by_name||"Responsable registrado")) : "Pendiente";
  return '<div class="linea" style="align-items:center"><input type="checkbox" style="width:24px;flex:none" '+(t.hecho?'checked':"")+' '+(read?'disabled':"")+' onchange="marcarTrabajo('+i+',this.checked)"><input aria-label="Trabajo" placeholder="Trabajo / revisión" value="'+esc(t.descripcion)+'" '+(read?'disabled':"")+' oninput="O.trabajos['+i+'].descripcion=this.value"><input aria-label="Precio" class="pr" type="number" min="0" value="'+(Number(t.precio)||0)+'" '+(read?'disabled':"")+' oninput="O.trabajos['+i+'].precio=this.value"></div><div class="mut" style="margin:-4px 0 10px 34px">'+esc(who)+'</div>';
}
function marcarTrabajo(i,checked) {
  const t=O.trabajos[i]; if(!t)return;
  t.hecho=checked;
  t.performed_by=checked?S.usuario_id:null;
  t.performed_by_name=checked?S.usuario:null;
  t.completed_at=checked?new Date().toISOString():null;
  pintarOtFilas();
}
const mostrarOrdenOriginal = window.mostrarOrden;
window.mostrarOrden = function() {
  mostrarOrdenOriginal();
  const title = document.querySelector("#modal-root .modal h2");
  const note = document.querySelector("#modal-root #ot-fotos")?.parentElement?.querySelector("p.mut");
  if(note) note.textContent="Primero guarda la orden. Las fotos se almacenan en el espacio privado de Chewbbie.";
  if(!esAdmin()) {
    document.querySelectorAll("#ot-fotos .btn.red").forEach(b=>b.remove());
    document.querySelectorAll("#modal-root button").forEach(b=>{if(b.textContent.trim()==="Ver factura")b.remove();});
  }
};
const paginasEvidenciasFacturaOriginal = window.paginasEvidenciasFactura;
window.paginasEvidenciasFactura = async function(f) {
  const order=S.ordenes.find(o=>o.factura_id===f.id);
  if(!order)return [];
  const photos=S.evidencias.filter(p=>p.orden_id===order.id);
  const canvases=[];
  for(const p of photos){
    const result=await api("fotoVer",{id:p.id});
    const img=new Image(); img.crossOrigin="anonymous";
    await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=result.imagen;});
    const width=900, ratio=img.naturalWidth/img.naturalHeight, imageH=Math.round(width/ratio);
    const canvas=document.createElement("canvas"); canvas.width=width; canvas.height=imageH+110;
    const ctx=canvas.getContext("2d"); ctx.fillStyle="#fff";ctx.fillRect(0,0,width,canvas.height);
    ctx.fillStyle="#5b21b6";ctx.font="bold 28px system-ui";ctx.fillText("Evidencia · "+p.etapa,28,42);
    ctx.fillStyle="#6b7280";ctx.font="16px system-ui";ctx.fillText("Orden "+num4(order.order_number||0)+" · "+esc(order.placa),28,72);
    ctx.drawImage(img,0,95,width,imageH);
    canvases.push(canvas);
  }
  return canvases;
};

function abrirFacturaOrden(id) {
  if(!esAdmin()) { toast("La facturación está disponible solo para administradores."); return; }
  const f=S.facturas.find(x=>x.id===id);
  if(f){cerrarModal(true);abrirFactura(f);}else toast("No se encontró la factura.");
}
function irNueva() { toast("Las facturas se generan desde una orden finalizada."); }
function toastTeamError(e){toast(e.message||"Ocurrió un error.");}
document.addEventListener("visibilitychange",async()=>{
  if(document.hidden||!ACTIVA||$("#modal-root").innerHTML)return;
  if(Date.now()-ULT<30000)return;
  try{await cargarDatos();if(vista!=="nueva"&&vista!=="config")render();}catch(e){}
});
iniciar();
