package dev.chirayupatel.music.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.chirayupatel.music.net.Session
import kotlinx.coroutines.launch

@Composable
fun SignInScreen(vm: AppViewModel) {
    var server by remember { mutableStateOf(vm.server.ifBlank { Session.DEFAULT_SERVER }) }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val submit = {
        if (!busy && password.isNotEmpty()) {
            busy = true; error = null
            scope.launch { error = vm.signIn(server, password); busy = false }
        }
    }
    Box(Modifier.fillMaxSize().background(Palette.Bg).windowInsetsPadding(WindowInsets.safeDrawing).imePadding(), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 340.dp).fillMaxWidth().padding(28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("ALBUM VIEWER", color = Palette.Ink, fontWeight = FontWeight.Bold, fontSize = 15.sp, letterSpacing = .16.em)
            Text("Your collection, back on the wall.", color = Palette.Muted, fontFamily = FontFamily.Serif, fontSize = 20.sp, modifier = Modifier.padding(bottom = 10.dp))
            Field(server, { server = it }, "Server", KeyboardType.Uri, ImeAction.Next)
            Field(password, { password = it }, "Password", KeyboardType.Password, ImeAction.Go, hidden = true, onDone = { submit() })
            error?.let { Text(it, color = Color(0xFFFF8A6B), fontSize = 14.sp) }
            PrimaryButton(if (busy) "Signing in…" else "Sign in", Modifier.fillMaxWidth().padding(top = 6.dp)) { submit() }
        }
    }
}

@Composable
private fun Field(
    value: String, onChange: (String) -> Unit, placeholder: String, type: KeyboardType, ime: ImeAction,
    hidden: Boolean = false, onDone: () -> Unit = {},
) {
    BasicTextField(
        value = value, onValueChange = onChange, singleLine = true,
        textStyle = TextStyle(color = Palette.Ink, fontSize = 16.sp),
        cursorBrush = SolidColor(Palette.Accent),
        visualTransformation = if (hidden) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = type, imeAction = ime, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onGo = { onDone() }, onDone = { onDone() }),
        modifier = Modifier.fillMaxWidth().height(50.dp),
        decorationBox = { field ->
            Box(
                Modifier.fillMaxSize().clip(RoundedCornerShape(10.dp)).background(Palette.Field)
                    .border(1.dp, Palette.Line, RoundedCornerShape(10.dp)).padding(horizontal = 14.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (value.isEmpty()) Text(placeholder, color = Palette.Muted, fontSize = 16.sp)
                field()
            }
        },
    )
}
