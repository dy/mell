// compile source/ast/ir to WAST
import parse from "./parse.js"
import stdlib from "./stdlib.js"
import {FLOAT,INT} from './const.js'
import { parse as parseWat } from "watr";

let includes, globals, funcs, locals, loopc, exports, block, heap;

const _tmp = Symbol('tmp')

// limit of memory is defined as: (max array length i24) / (number of f64 per memory page i13)
const MAX_MEMORY = 2048

export default function compile(node) {
  if (typeof node === 'string') node = parse(node)
  console.log('compile', node)

  // init compiling context
  // FIXME: make temp vars just part of local scope
  globals = {[_tmp]:[]}, // global scope (as name props)
  locals, // current fn local scope
  includes = [], // pieces to prepend
  funcs = {}, // defined user and util functions
  loopc = 0, // current loop number
  block = Object.assign([''],{cur:0}), // current block count
  exports = null, // items to export
  heap = 0 // heap size as number of pages (detected from max static array size)

  // run global in start function
  let init = expr(node), out = ``

  // run globals init, if needed
  if (init) out = `(func $__main\n` +
    globals[_tmp].map((tmp)=>`(local ${tmp})`).join('') +
    `\n${init}\n` +
    `(return))\n` +
  `(start $__main)\n`

  if (heap) out += `(memory (export "__memory") ${heap} ${MAX_MEMORY})(global $mem (mut i32) (i32.const ${heap<<16}))(global $heap (mut i32) (i32.const 0))\n`

  // declare variables
  // NOTE: it sets functions as global variables
  for (let name in globals)
    out = `(global $${name} (mut ${globals[name].type}) (${globals[name].type}.const 0))\n` + out

  // declare funcs
  for (let name in funcs)
    out = funcs[name] + '\n' + out

  // declare includes
  for (let include of includes)
    if (stdlib[include]) out = stdlib[include] + '\n' + out; else err('Unknown include `' + include + '`')

  // provide exports
  for (let name in exports)
    out += `\n(export "${name}" (${exports[name].func ? 'func' : 'global'} $${name}))`

  console.log(out)
  // console.log(...parseWat(out))

  return out
}

// processess global statements, returns nothing, only modifies globals, inits, out, memory
function expr(statement) {
  if (!statement) return ''
  // a; - just declare in proper scope
  // FIXME: funcs may need returning something meaningful
  if (typeof statement === 'string') {
    // just x,y; or a=x; where x is undefined
    statement = define(statement);
    return op(`(${locals?.[statement]?'local':'global'}.get $${statement})`,`f64`)
  }
  if (statement[0] in expr) return expr[statement[0]](statement) || ''
  err('Unknown operation `' + statement[0] + '`',statement)
}

Object.assign(expr, {
  // number primitives: 1.0, 2 etc.
  [FLOAT]([,a]) { return op(`(f64.const ${a})`,'f64',{static:true})},
  [INT]([,a]) { return op(`(i32.const ${a})`,'i32',{static:true})},

  // a; b; c;
  ';'([,...statements]){
    let list=[];
    for (let s of statements) s && list.push(expr(s));
    list = list.filter(Boolean)

    return op(
      list.map((op,i) => op + `(drop)`.repeat(i===list.length-1 ? 0 : op.type.length)).join('\n'),
      list[list.length-1].type,
      {static:list[list.length-1].static}
    )
  },

  ','([,...statements]){
    let list=[];
    for (let s of statements) list.push(expr(s));
    list = list.filter(Boolean)
    return op(list.join('\n'), list.flatMap(op=>op.type), {static:list.every(op=>op.static)})
  },

  '('([,body]){
    // ((a)) -> a
    while (body[0]==='(') body = body[1]

    // resolve block scopes var names conflict
    block.cur++
    block[block.cur]=(block[block.cur]||0)+1

    // FIXME: detect block type, if it needs early return - then we ought to wrap it
    let res = expr(body)

    block.cur--

    return res
  },

  '()'([,name, list]) {
    list = !list ? [] : list[0]===',' ? list.slice(1) : list

    if (!globals[name]) err('Unknown function call: ' + name)

    // FIXME: make sure default args are gotten values
    let {args} = globals[name]

    return op(`(call $${name} ${list.map(arg => asFloat(expr(arg))).join(' ')})`, 'f64')
  },

  // [1,2,3]
  '['([,inits]) {
    // NOTE: this expects heap pointer in stack
    inits = !inits ? [] : inits[0] !== ',' ? [inits] : inits.slice(1)

    inc('malloc'), inc('ref')

    // return buffer initializer
    return buf(inits)
  },

  // a[b] or a[]
  '[]'([,a,b]) {
    // // a[10], a[n] - create an array of defined length
    // if (typeof a === 'string') {
    //   a = varName(a)
    //   // define array, if it doesn't exist
    //   if (!locals?.[a] && !globals[a]) {
    //     define(a)
    //     // x[] - returns 0
    //     if (!b) return op(`(i32.const 0)`, 'i32')

    //     inc('buf.new'), inc('ref')

    //     // a[10] - initializes array variable of defined size
    //     return op(`(${locals ? 'local' : 'global'}.set $${a} (call $buf.new ${expr(b)}))(f64.const 0)`)
    //   }
    // }

    // a[] - length
    if (!b) return inc('ref.len'), op(`(call $ref.len ${expr(a)})`,'i32')

    // a[b] - regular access
    return inc('buf.get'), op(`(call $buf.get ${expr(a)} ${expr(b)})`)
  },

  '='([,a,b]) {
    while (a[0] === '(') a = a[1] // unbracket

    // x[y]=1, x.y=1
    if (a[0] === '[]' || a[0] === '.') {
      let [,buf,idx] = a
      if (a[0] === '.') idx = [INT, parseInt(idx)]

      // FIXME: add static optimization here for property - to avoid calling i32.modwrap if idx is known
      // FIXME: another static optimization: if length is known in advance (likely yes) - make static modwrap

      return inc('ref.len'), inc('buf.set'), inc('i32.modwrap'), op(`(call $buf.tee ${expr(buf)} ${asInt(expr(idx))} ${asFloat(expr(b))})`, 'f64')
    }

    // a = b,  a = (b,c),   a = (b;c,d)
    if (typeof a === 'string') {
      a = define(a)
      return op(locals ? `(local.tee $${a} ${pick(1,asFloat(expr(b)))})` : `(global.set $${a} ${pick(1,asFloat(expr(b)))})(global.get $${a})`, 'f64')
    }

    // (a,b) = ...
    if (a[0]===',') {
      let [,...outputs] = a, inputs = pick(outputs.length,expr(b))

      // (a,b,c)=(c,d) -> (a,b)=(c,d)
      if (inputs.type.length > 1) outputs = outputs.slice(0, inputs.type.length)

      // set as `(i32.const 1)(i32.const 2)(local.set 1)(local.set 0)`
      return op(
        inputs + '\n'+
        outputs.map((n,i)=> (
          n=define(n), `${inputs.type[i] === 'i32' ? `(f64.convert_i32_s)` : ''}(${globals[n]?`global`:`local`}.set $${n})`
        )).reverse().join('') +
        outputs.map(n=>(n=define(n), `(${globals[n]?'global':'local'}.get $${n})`)).join(''),
        Array(outputs.length).fill(`f64`)
      )
    }

    // x(a,b) = y
    if (a[0]==='()') {
      let [,name,args] = a, body = b, inits = [], result, dfn = []

      // functions defined within scope of other functions, `x()=(y(a)=a;)`
      if (locals) err('Declaring local function `' + name +'`: not allowed');

      // FIXME: maybe it's ok to redeclare function? then we'd need to use table
      if (globals[name]) err('Redefining function `' + name + '`: not allowed');

      locals = {[_tmp]:[]}

      // normalize body to (a;b;) form
      body = body[0]==='(' ? body : ['(',body]
      body[1] = body[1][0] === ';' ? body[1] : [';',body[1]]

      // get args list
      args = !args ? [] : args[0] === ',' ? args.slice(1) : [args];

      // detect optional / clamped args
      args = args.map(arg => {
        let name, init

        // x(a,b)
        if (typeof arg === 'string') name = arg
        // x(a=1,b=2), x(a=(1;2))
        else if (arg[0]==='=') [,name,init] = arg, inits.push(['?',['!=',name,name],['=',name,init]])
        // x(x<?2..3)
        else if (arg[0]==='<?') [,name,init] = arg, inits.push(['<?=',name,arg[2]])
        else err('Unknown function argument')

        locals[name] = {arg:true}

        dfn.push(`(param $${name} f64)`)
        return name
      })

      body[1].splice(1,0,...inits) // prepend inits
      result = expr(body)

      // define result, comes after (param) before (local)
      if (result.type.length) dfn.push(`(result ${result.type.join(' ')})`)

      // declare locals
      for (let name in locals) if (!locals[name].arg) dfn.push(`(local $${name} ${locals[name].type})`)

      // declare tmps
      dfn.push(locals[_tmp].map((tmp)=>`(local ${tmp})`).join(''))

      locals = null

      globals[name] = {func:true, args, type:'i32'}; // NOTE: we set type to i32 as preliminary pointer to function (must be in a table)
      if (exports) exports[name] = globals[name]

      // init body - expressions write themselves to body
      funcs[name] = `(func $${name} ${dfn.join(' ')}\n${result}\n(return))`

      return
    }

    err('Unknown assignment', a)
  },

  // a <| b
  '<|'([,a,b]) {
    return op(loop(a,b,false),'f64',{dynamic:true})
  },

  // a |> (b,c)->d
  '|>'([,a,b]) {

  },

  '-'([,a,b]) {
    // [-, [int, a]] -> (i32.const -a)
    if (!b) {
      if (a[0] == INT || a[0] == FLOAT) return expr([a[0], -a[1]])
      let res = expr(a)
      if (res.type.length > 1) err('Group negation: unimplemented')
      if (res.type[0] === 'i32') return op(`(i32.sub (i32.const 0) ${res})`, 'i32', {static:res.static})
      return `(f64.neg ${res})`
    }

    let aop = expr(a), bop = expr(b)
    if (aop.type.length > 1 || bop.type.length > 1) err('Group subtraction: unimplemented')
    if (aop.type[0] === 'i32' && bop.type[0] === 'i32') return op(`(i32.sub ${aop} ${bop})`, 'i32')
    return op(`(f64.sub ${asFloat(aop)} ${asFloat(bop)})`, 'f64')
  },
  '+'([,a,b]) {
    let aop = expr(a), bop = expr(b)
    if (aop.type[0] == 'i32' && bop.type[0] == 'i32') return op(`(i32.add ${aop} ${bop})`, 'i32')
    return op(`(f64.add ${asFloat(aop)} ${asFloat(bop)})`,'f64')
  },
  '*'([,a,b]) {
    // FIXME: stateful variable
    if (!b) {
      locals[a].stateful = true
      err('Stateful variable: unimplemented')
      return ``
    }
    let aop = expr(a), bop = expr(b)
    return op(`(f64.mul ${asFloat(aop)} ${asFloat(bop)})`,'f64')
  },
  '/'(){
    let aop = expr(a), bop = expr(b)
    return op(`(f64.div ${asFloat(aop)} ${asFloat(bop)})`,'f64')
  },
  '++'([,a]) { return expr(['+=',a,[INT,1]]) },
  '--'([,a]) { return expr(['-=',a,[INT,1]]) },
  '+='([,a,b]) { return expr(['=',a,['+',a,b]]) },
  '-='([,a,b]) { return expr(['=',a,['-',a,b]]) },
  '%%'([,a,b]) {
    // common case of int is array index access
    if (getDesc(a).type === INT && getDesc(b).type === INT) return inc('i32.modwrap'), call('i32.modwrap', a, b)
    return inc('f64.modwrap'), expr(['()','f64.modwrap', [',',a, b]])
  },
  // a | b
  '|'([,a,b]) {
    // console.log('|',a,b)
    // 0 | b -> b | 0
    if (a[0] === INT && a[1] === 0) [a,b]=[b,a]

    let aop = expr(a), bop = expr(b);
    return op(`(i32.or ${asInt(aop)} ${asInt(bop)})`,'i32')
  },

  // comparisons
  '<'([,a,b]) {
    let aop = expr(a), bop = expr(b)
    if (aop.type[0] === 'i32' && bop.type[0] === 'i32') return op(`(i32.lt_s ${aop} ${bop})`,'i32')
    return op(`(f64.lt ${asFloat(aop)} ${asFloat(bop)})`,'i32')
  },
  '<='([,a,b]) {
    let aop = expr(a), bop = expr(b)
    if (aop.type[0] === 'i32' && bop.type[0] === 'i32') return op(`(i32.le_s ${aop} ${bop})`,'i32')
    return op(`(f64.le ${asFloat(aop)} ${asFloat(bop)})`,'i32')
  },
  '>'([,a,b]) {
    let aop = expr(a), bop = expr(b)
    if (aop.type[0] === 'i32' && bop.type[0] === 'i32') return op(`(i32.gt_s ${aop} ${bop})`,'i32')
    return op(`(f64.gt ${asFloat(aop)} ${asFloat(bop)})`,'i32')
  },
  '>='([,a,b]) {
    let aop = expr(a), bop = expr(b)
    if (aop.type[0] === 'i32' && bop.type[0] === 'i32') return op(`(i32.ge_s ${aop} ${bop})`,'i32')
    return op(`(f64.ge ${asFloat(aop)} ${asFloat(bop)})`,'i32')
  },
  '=='([,a,b]) {
    let aop = expr(a), bop = expr(b)
    if (aop.type[0] === 'i32' && bop.type[0] === 'i32') return op(`(i32.eq_s ${aop} ${bop})`,'i32')
    return op(`(f64.eq ${asFloat(aop)} ${asFloat(bop)})`,'i32')
  },
  '!='([,a,b]) {
    let aop = expr(a), bop = expr(b)
    if (aop.type[0] === 'i32' && bop.type[0] === 'i32') return op(`(i32.ne_s ${aop} ${bop})`,'i32')
    return op(`(f64.ne ${asFloat(aop)} ${asFloat(bop)})`,'i32')
  },

  // logical - we put value twice to the stack and then just drop if not needed
  '||'([,a,b]) {
    let aop = expr(a), bop = expr(b)
    if (aop.type[0]=='f64') return op(`${pick(2,aop)}(if (param f64) (result f64) (f64.ne (f64.const 0)) (then) (else (drop) ${asFloat(bop)}))`,'f64')
    if (bop.type[0]=='i32') return op(`${pick(2,aop)}(if (param i32) (result i32) (then) (else (drop) ${bop}))`,'i32')
    return op(`${pick(2,aop)}(if (param i32) (result f64) (then (f64.convert_i32_s)) (else (drop) ${asFloat(bop)}))`,'f64')
  },
  '&&'([,a,b]) {
    let aop = expr(a), bop = expr(b)
    if (aop.type[0]=='f64') return op(`${pick(2,aop)}(if (param f64) (result f64) (f64.ne (f64.const 0)) (then (drop) ${asFloat(bop)}))`,'f64')
    if (bop.type[0]=='i32') return op(`${pick(2,aop)}(if (param i32) (result i32) (then (drop) ${bop}))`,'i32')
    return op(`${pick(2,aop)}(if (param i32) (result f64) (then (f64.convert_i32_s) (drop) ${asFloat(bop)}))`,'f64')
  },
  // parsing alias ? -> ?:
  '?'([,a,b]) {return expr['?:'](['?:',a,b,[FLOAT,0]])},
  '?:'([,a,b,c]) {
    if (!c) c=b, b=[FLOAT,0]; // parsing alias
    let aop = expr(a), bop = expr(b), cop = expr(c)
    return op(`(if (result f64) ${aop.type[0]=='i32'?aop:`(f64.ne ${aop} (f64.const 0))`} (then ${asFloat(bop)}) (else ${asFloat(cop)}))`, 'f64')
  },

  // a <? range - clamp a to indicated range
  '<?'([,a,b]) {
    if (b[0] !== '..') err('Non-range passed as right side of clamp operator')
    let [,min,max] = b, aop = expr(a), minop = min && expr(min), maxop = max && expr(max)

    // a <? 0..
    if (!max) {
      if (aop.type[0] === 'i32' && minop.type[0] === 'i32') return inc('i32.smax'), op(`(call $i32.max ${aop} ${minop})`,'i32')
      return op(`(f64.max ${asFloat(aop)} ${asFloat(minop)})`, 'f64')
    }
    // a <? ..10
    if (!min) {
      if (aop.type[0] === 'i32' && maxop.type[0] === 'i32') return inc('i32.smin'), op(`(call $i32.min ${aop} ${maxop})`,'i32')
      return op(`(f64.min ${asFloat(aop)} ${asFloat(maxop)})`, 'f64')
    }
    // a <? 0..10
    if (aop.type == 'i32' && minop.type == 'i32' && maxop.type == 'i32') {
      return inc('i32.smax'),inc('i32.smin'), op(`(call $i32.smax (call $i32.smin ${aop} ${maxop}) ${minop})`,'i32')
    }
    return op(`(f64.max (f64.min ${asFloat(aop)} ${asFloat(maxop)}) ${asFloat(minop)})`, 'f64')
  },

  // @ 'math#sin', @ 'path/to/lib'
  '@'([,path]) {
    if (locals) err('Import must be in global scope')
    if (Array.isArray(path)) path[0] === "'" ? path = path[1] : err('Bad path `' + path + '`')
    let url = new URL('import:'+path)
    let {hash, pathname} = url
    throw 'Unimplemented'

    // FIXME: include directive into syntax tree
    // let src = fetchSource(pathname)
    // let include = parse(src)
    // node.splice(node.indexOf(impNode), 1, null, include)

    let lib = stdlib[pathname], members = hash ? hash.slice(1).split(',') : Object.keys(lib)
    for (let member of members) {
      scope[member] = { import: pathname, type: lib[member][1] }
    }
    // we return nothing since member is marked as imported
    return ''
  },

  // a,b,c . x?
  '.'([,a,b]) {
    // a.b
    if (b) err('Prop access is unimplemented ' + a + b, a)

    if (locals) err('Export must be in global scope')
    // FIXME: if (expNode !== node && expNode !== node[node.length-1]) err('Export must be the last node');

    exports = {}
    return expr(a)
  },
})

// define variable in current scope, export if necessary; returns resolved name
function define(name, type='f64') {
  name += block.slice(0,block.cur).join('.')
  if (!locals) {
    if (!globals[name]) globals[name] = {var:true, type}
    if (!locals && exports) exports[name] = globals[name]
  }
  else {
    if (!locals[name]) locals[name] = {var:true, type}
  }
  return name
}

// define temp variable, always in local scope; returns tmp var name
// FIXME: possibly can turn it into `define`
// FIXME: tmp should be able to free variable once finished using
function tmp(name, type='f64') {
  let len = (locals || globals)[_tmp].length || ''
  name = `tmp${len}.${name}`
  ;(locals || globals)[_tmp].push(`$${name} ${type}`)
  return name
}

// create array initializer op (via heap), from element nodes
function buf(inits) {
  let src = tmp('src','i32'), dst = tmp('dst', 'i32'), size = tmp('size','i32')

  heap = Math.max(heap, 1); // min heap is 8192 elements

  let out = `(global.get $heap)(local.set $${src})\n` // put heap ptr to stack

  // TODO: if inits don't contain computed ranges or comprehension, we can init memory directly via data section

  // each element saves value to memory and increases heap pointer in stack
  for (let init of inits) {
    // [a..b], [..b]
    if (init[0] === '..') {
      let [,min,max] = init
      if (!max) err('Arrays cannot be constructed from right-open ranges, TODO passed')

      // [..1] - just skips heap
      if (!min && typeof max[1] === 'number') {
        out += `(global.get $heap)(i32.add (i32.shl (i32.const ${max[1]}) (i32.const 3)))(global.set $heap)\n`
        heap = Math.max(heap, max[1] >> 12) // increase heap
      }
      // [x..y] - generic computed range
      else {
        inc('range')
        // increase heap
        if (typeof min[1] === 'number' && typeof max[1] === 'number') heap = Math.max(heap, (max[1]-min[1]) >> 12)
        // create range in memory from ptr in stack
        out += `(global.get $heap)(call $range ${asFloat(expr(min))} ${asFloat(expr(max))} (f64.const 1))(global.set $heap)\n`
      }
    }
    // [a..b <| ...] - comprehension
    else if (init[0] === '<|') {
      // let lop = loop(init, true)
      // out += `(i32.add ${lop})`;
      // TODO: comprehension - expects heap address in stack, puts loop results into heap
    }
    // [x*2] - single value (reuses dst as temp holder)
    else out += `(global.get $heap)(local.tee $${dst})(f64.store ${asFloat(expr(init))}) (i32.add (local.get $${dst}) (i32.const 8))(global.set $heap)\n`
  }

  // move buffer to static memory: references static address, deallocates heap tail

  out += `(local.set $${size} (i32.sub (global.get $heap) (local.get $${src})))` // get length of created array
  + `(local.set $${dst} (call $malloc (local.get $${size})))` // allocate new memory
  + `(memory.copy (local.get $${dst}) (local.get $${src}) (local.get $${size}))` // move heap to static memory
  + `(global.set $heap (local.get $${src}))` // free heap
  + `(call $ref (local.get $${dst}) (i32.shr_u (local.get $${size}) (i32.const 3)) )` // create reference

  return op(out,'f64',{buf:true})
}

// return loop expression, possibly with saving results to heap
function loop(node, save=false) {
  // // [.. <| x -> x]
  // if (init[2][0] === '->') {

  // }
  // // [.. <| expr]
  // else {

  // }


  loopc++

  let from, to, next, params, pre
  let idx = tmp('idx','i32'), item = define('#'.repeat(loopc),'f64'), end = tmp('end','i32')

  // a..b <| ...
  if (a[0]==='..') {
    // i = from; to; while (i < to) {# = i; ...; i++}
    let [,min,max] = a
    from = asInt(expr(min)), to = asInt(expr(max)), next = `(f64.convert_i32_s (local.get $${idx}))`, params = ``, pre = ``
  }
  // list <| ...
  else {
    let aop = expr(a)
    // (a,b,c) <| ...
    if (aop.type.length > 1) {
      // we create tmp list for this group and iterate over it, then after loop we dump it into stack and free memory
      // i=0; to=types.length; while (i < to) {# = stack.pop(); ...; i++}
      from = `(i32.const 0)`, to = `(i32.const ${aop.type.length})`
      next = `(f64.load (i32.add (global.get $heap.ptr) (local.get $${idx})))`
      params = ``
      // push args into heap
      // FIXME: should we use $heap.push3() function?
      for (let i = 0; i < aop.type.length; i++) {
        let t = aop.type[aop.type.length - i - 1]
        pre += `${t==='f64'?'(f64.convert_i32_s)':'()'}(f64.store (i32.add (global.get $heap.ptr) (i32.const ${i << 3})))`
      }
    }
    // (0..10 <| a ? ^b : c) <| ...
    else if (aop.dynamic) {
      // dynamic args are already in heap
      from = `(i32.const 0)`, to = `(global.get $heap.size)`
      next = `(f64.load (i32.add (global.get $heap.ptr) (local.get $${idx})))`
      params = ``
      err('Unimplemented: dynamic loop arguments')
      // FIXME: must be reading from heap: heap can just be a list also
    }
    // list <| ...
    else {
      // i = 0; to=buf[]; while (i < to) {# = buf[i]; ...; i++}
      inc('ref.len'), inc('buf.get')
      from = `(i32.const 0)`, to = `(call $ref.len ${aop})`, next = `(call $buf.get ${aop} (local.get $${idx}))`
      params = ``, pre = ``
    }
  }

  let res = `${pre}\n` +
  `(local.set $${idx} ${from})\n` +
  `(local.set $${end} ${to})\n` +
  `(loop $loop${loopc} ${params} (result f64)\n` +
    `(${locals?.[item] ? 'local':'global'}.set $${item} ${next})\n` +
    `(if (result f64) (i32.le_s (local.get $${idx}) (local.get $${end}))\n` +
      `(then\n` +
        `${expr(b)}\n` +
        // save result to heap, if required
        // save ? `(f64.store (i32.add (global.get $heap.ptr) (local.get $${idx}))` : `` +
        `(local.set $${idx} (i32.add (local.get $${idx}) (i32.const 1)))` +
        // `(call $f64.log (global.get $${item}))` +
        `(br $loop${loop})\n` +
      `)\n` +
      `(else (f64.const 0))\n` +
  `))\n`

  loopc--

  return res
}

// wrap expression to float, if needed
function asFloat(o) {
  if (o.type[0] === 'f64') return o
  // avoid unnecessary const converters
  if (o.startsWith('(i32.const')) return op(o.replace('(i32','(f64'), 'f64')
  return op(`(f64.convert_i32_s ${o})`, 'f64')
}
// cast expr to int
function asInt(o) {
  if (o.type[0] === 'i32') return o
  // return op(`(i32.trunc_sat_f64_s ${o})`, 'i32')
  return op(`(i32.trunc_f64_s ${o})`, 'i32')
}

// add include from stdlib and return call
function inc(name) {
  if (!includes.includes(name)) includes.push(name)
}

// pick N input args back into stack, like (a,b,c) -> (a,b)
// FIXME: ignore types, make only f64 type, call as `f64.pick_4_3`? too many funcs with similar meaning like pick/i32_f64_2, pick/f64_f64_2 - we anyways use it only in swizzling
function pick(count, input) {
  let name

  // if expression is 1 element, eg. (a,b,c) = d - we duplicate it to stack
  if (input.type.length === 1) {
    // a = b - skip picking
    if (count === 1) return input
    // (a,b,c) = d
    let {type} = input
    name = `$pick/${type}_${count}`
    if (!funcs[name]) {
      funcs[name] = `(func ${name} (param ${type}) (result ${(type+' ').repeat(count)}) ${`(local.get 0)`.repeat(count)} (return))`
    }
    return op(`(call ${name} ${input})`, input.type, {static: input.static})
  }

  // N:M or 1:M picker - trims stack to n els
  name = `$pick/${input.type.join('_')}_${count}`
  if (!funcs[name]) {
    funcs[name] = `(func ${name} (param ${input.type.join(' ')}) (result ${input.type.slice(0,count).join(' ')}) ${input.type.slice(0,count).map((o,i) => `(local.get ${i})`).join('')} (return))`
  }

  return op(`(call ${name} ${input})`, input.type.slice(0,count), {static: input.static})
}

// create op result
// holds number of returns (ops)
// makes sure it stringifies properly into wasm expression
// provides any additional info: types, static, min/max etc
// supposed to be a replacement for getDesc to avoid mirroring every possible op
function op(str, type, info={}) {
  str = new String(str)
  if (!type) type = []
  else if (typeof type === 'string') type = [type]
  return Object.assign(str, {type, ...info})
}

// show error meaningfully
export function err(msg, node={}) {
  // Promise.resolve().then(() => {
    throw Error((msg || 'Bad syntax') + ' `' + node.toString() + '`' )
  // })
}

// fetch source file by path - uses import maps algorighm
// FIXME: can extend with importmap
const coreModules = {math:'./math.lino'}
function fetchSource (path) {
  let fullPath = import.meta.resolve(coreModules[path])
  let xhr = new XMLHttpRequest ()
  xhr.open ('GET', fullPath, false /* SYNCHRONOUS XHR FTW :) */)
  xhr.send (null)
  // result = (nodeRequire ('fs').readFileSync (path, { encoding: 'utf8' }))
  return xhr.responseText
}