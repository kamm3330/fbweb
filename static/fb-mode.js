// FreeBASIC-Modus für CodeMirror 5: Syntaxhervorhebung + automatisches Einrücken
(function () {
  "use strict";
  function words(s) { const o = Object.create(null); s.split(/\s+/).forEach(w => { if (w) o[w] = true; }); return o; }

  const keywords = words(`
    and andalso as byref byval call case cast class const constructor continue declare destructor dim do
    each else elseif end endif enum eqv exit explicit export extern for function gosub goto if iif imp implements
    import is let lib loop mod namespace new next not on operator option or orelse overload override private
    property protected public redim rem return scope select shared shl shr static step sub then to type
    typeof union until using var virtual wend while with xor abstract alias base this delete preserve
    naked cdecl stdcall pascal fastcall thiscall
    asm extends field goto resume error local defint deflng defsng defdbl defstr defbyte defubyte
    defshort defushort deflongint defulongint defuint`);

  const types = words(`
    boolean byte ubyte short ushort integer uinteger long ulong longint ulongint single double
    string zstring wstring any ptr pointer unsigned object true false`);

  const builtins = words(`
    print input line circle pset preset paint draw screen screenres screenlock screenunlock screensync
    screenset screencopy screeninfo screenlist screenevent screenptr screencontrol screenglproc flip pcopy
    cls color locate width view window palette get put bload bsave point pmap csrlin pos
    imagecreate imagedestroy imageinfo imageconvertrow windowtitle event rgb rgba
    sleep inkey getkey multikey getmouse setmouse getjoystick stick strig
    randomize rnd int fix frac abs sgn sqr sin cos tan asin acos atn atan2 exp log
    len left right mid instr instrrev ucase lcase ltrim rtrim trim str wstr val valint vallng valuint valulng
    chr wchr asc hex oct bin space wspace lset rset format
    timer date time setdate settime now
    open close eof lof loc seek kill mkdir rmdir chdir curdir exepath dir filecopy fileexists filelen
    filedatetime fileattr freefile write reset lock unlock lprint
    beep sound shell run exec chain command environ setenviron end stop system swap erase lbound ubound clear
    allocate callocate reallocate deallocate peek poke sizeof varptr strptr procptr offsetof
    cint clng cdbl csng cbyte cubyte cshort cushort cuint culng clngint culngint cptr csign cunsg cbool
    mki mkl mks mkd mkshort mklongint cvi cvl cvs cvd cvshort cvlongint
    data read restore err erl threadcreate threadwait threadcall threaddetach threadself
    mutexcreate mutexlock mutexunlock mutexdestroy condcreate condwait condsignal condbroadcast conddestroy
    dylibload dylibsymbol dylibfree inp out wait fre outp int_ loword hiword lobyte hibyte bit bitset bitreset
    va_first va_arg va_next assert assertwarn __function__ __file__ __line__ __date__ __time__ __fb_version__`);

  const openers = words("for do while sub function select with scope enum namespace union constructor destructor operator property asm");
  const modifiers = words("private public static protected virtual abstract override");
  const closersAfterEnd = words("if sub function select with scope enum namespace union type constructor destructor operator property asm");
  const loopClosers = words("next loop wend");
  const middles = words("else elseif case");

  CodeMirror.defineMode("freebasic", function (config) {
    const unit = config.indentUnit || 4;

    function tokenBase(stream, state) {
      if (stream.eatSpace()) return null;
      const ch = stream.peek();

      // Präprozessor: # am Zeilenanfang
      if (ch === "#" && state.lineWords.length === 0) {
        stream.next(); stream.eatWhile(/[\w]/);
        return "meta";
      }
      // Kommentare
      if (ch === "'") {
        if (stream.match(/^'\s*\$\w+/)) { stream.skipToEnd(); return "meta"; }
        stream.skipToEnd(); return "comment";
      }
      if (stream.match("/'")) { state.tokenize = tokenBlockComment; state.commentDepth = 1; return tokenBlockComment(stream, state); }

      // Strings: "..."  !"..." (mit Escapes)  $"..." (ohne)
      if (ch === '"' || ((ch === "!" || ch === "$") && stream.string.charAt(stream.pos + 1) === '"')) {
        const esc = ch === "!";
        if (ch !== '"') stream.next();
        stream.next();
        while (!stream.eol()) {
          const c = stream.next();
          if (esc && c === "\\") { stream.next(); continue; }
          if (c === '"') { if (stream.peek() === '"') { stream.next(); continue; } break; }
        }
        state.lineWords.push('"');
        return "string";
      }

      // Zahlen
      if (stream.match(/^&h[0-9a-f]+/i) || stream.match(/^&o[0-7]+/i) || stream.match(/^&b[01]+/i) ||
          stream.match(/^(\d+\.?\d*|\.\d+)([ed][+-]?\d+)?/i)) {
        stream.match(/^(ull|ll|ul|u|l|f|d|%|&|!|#)/i);
        state.lineWords.push("0");
        return "number";
      }

      // Bezeichner / Schlüsselwörter
      if (stream.match(/^[a-z_][\w]*/i)) {
        const w = stream.current().toLowerCase();
        stream.match(/^[$%&!#]/);   // Typsuffix (a$, b%)
        if (w === "rem" && state.lineWords.length === 0 || w === "rem" && state.lastWord === ":") { stream.skipToEnd(); return "comment"; }
        // Sprungmarke am Zeilenanfang:  name:
        if (state.lineWords.length === 0 && stream.peek() === ":" && !keywords[w] && !builtins[w] && stream.string.charAt(stream.pos + 1) !== "=") {
          stream.next(); state.lineWords.push(w); return "tag";
        }
        state.lineWords.push(w);
        state.lastWord = w;
        if (keywords[w]) return "keyword";
        if (types[w]) return "type";
        if (builtins[w]) return "builtin";
        return "variable";
      }

      if (stream.match(/^(<>|<=|>=|->|\+=|-=|\*=|\/=|\\=|\^=|&=|=>|[-+*\/\\^=<>@&.])/)) { state.lineWords.push("op"); return "operator"; }
      if (ch === ":") { stream.next(); state.lastWord = ":"; state.lineWords.push(":"); return null; }
      if (ch === "_" ) { stream.next(); return "operator"; }
      stream.next();
      state.lineWords.push(ch);
      return null;
    }

    function tokenBlockComment(stream, state) {
      while (!stream.eol()) {
        if (stream.match("/'")) state.commentDepth++;
        else if (stream.match("'/")) { if (--state.commentDepth === 0) { state.tokenize = tokenBase; break; } }
        else stream.next();
      }
      return "comment";
    }

    // Wirkung einer fertigen Zeile auf die Einrücktiefe
    function lineDelta(ws) {
      let i = 0;
      while (i < ws.length && modifiers[ws[i]]) i++;
      const f = ws[i], s = ws[i + 1];
      if (!f) return 0;
      if (f === "declare") return 0;
      if (f === "end" && s && closersAfterEnd[s]) return s === "select" ? -2 : -1;
      if (f === "endif") return -1;
      if (loopClosers[f]) return -1;
      if (f === "if") return ws[ws.length - 1] === "then" ? 1 : 0;
      if (f === "type") return ws[2] === "as" ? 0 : 1;   // "Type Foo As Integer" ist nur ein Alias
      if (f === "select") return 2;
      if (f === "do" || f === "while" || f === "for" || f === "with" || f === "scope" || f === "enum" ||
          f === "namespace" || f === "union" || f === "asm") return 1;
      if (f === "sub" || f === "function" || f === "constructor" || f === "destructor" || f === "operator" || f === "property")
        return ws.indexOf("=") !== -1 && f !== "operator" && f !== "property" ? 0 : 1;
      return 0;
    }

    function finishLine(state) {
      if (state.lineWords.length) {
        state.depth = Math.max(0, state.depth + lineDelta(state.lineWords));
      }
      state.lineWords = [];
      state.lastWord = null;
    }

    return {
      startState: () => ({ tokenize: tokenBase, depth: 0, lineWords: [], lastWord: null, commentDepth: 0 }),
      copyState: s => ({ tokenize: s.tokenize, depth: s.depth, lineWords: s.lineWords.slice(), lastWord: s.lastWord, commentDepth: s.commentDepth }),
      token: function (stream, state) {
        if (stream.sol() && state.lineWords.length && state.tokenize === tokenBase) finishLine(state);
        const style = state.tokenize(stream, state);
        if (stream.eol() && state.tokenize === tokenBase) finishLine(state);
        return style;
      },
      blankLine: function (state) { if (state.lineWords.length) finishLine(state); },
      indent: function (state, textAfter) {
        if (state.tokenize !== tokenBase) return CodeMirror.Pass;
        const m = /^\s*([a-z#]+)(?:\s+([a-z]+))?/i.exec(textAfter || "");
        let d = state.depth;
        if (m) {
          const f = m[1].toLowerCase(), s = (m[2] || "").toLowerCase();
          if (f === "end" && closersAfterEnd[s]) d -= (s === "select" ? 2 : 1);
          else if (f === "endif" || loopClosers[f] || middles[f]) d -= 1;
        }
        return Math.max(0, d) * unit;
      },
      electricInput: /^\s*(end\s+\w+|next|loop|wend|else|elseif|case|endif)\b/i,
      lineComment: "'",
      blockCommentStart: "/'",
      blockCommentEnd: "'/",
      fold: "indent",
    };
  });

  CodeMirror.defineMIME("text/x-freebasic", "freebasic");

  // Wortliste für die Autovervollständigung
  window.FB_WORDS = Object.keys(keywords).concat(Object.keys(types), Object.keys(builtins))
    .filter(w => !/_$/.test(w)).sort();
})();
