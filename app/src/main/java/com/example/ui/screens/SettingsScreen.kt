package com.example.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.AdminProfile
import com.example.ui.theme.*

@Composable
fun SettingsScreen(
    adminProfile: AdminProfile,
    isDarkTheme: Boolean,
    currentLanguage: String,
    onToggleTheme: () -> Unit,
    onToggleLanguage: () -> Unit,
    onChangePassword: (oldPass: String, newPass: String) -> Unit,
    onLogout: () -> Unit
) {
    var showChangePassDialog by remember { mutableStateOf(false) }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Admin Profile Details
        item {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = BgCard),
                border = androidx.compose.foundation.BorderStroke(1.dp, GoldBorder)
            ) {
                Column(modifier = Modifier.padding(18.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Person, contentDescription = null, tint = GoldPrimary, modifier = Modifier.size(28.dp))
                        Spacer(modifier = Modifier.width(10.dp))
                        Column {
                            Text(adminProfile.name, color = TextMain, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                            Text(adminProfile.email, color = TextMuted, fontSize = 12.sp)
                        }
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text("Role: ${adminProfile.role}", color = GoldPrimary, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                        Text("Parent: ${adminProfile.parentAdminId}", color = TextDim, fontSize = 11.sp)
                    }

                    Spacer(modifier = Modifier.height(6.dp))

                    Text("Database: Shared Master Firebase Backend", color = SuccessGreen, fontSize = 11.sp)
                }
            }
        }

        // Appearance & Localization
        item {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = BgCard),
                border = androidx.compose.foundation.BorderStroke(1.dp, GoldLineSubtle)
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Text("APP PREFERENCES", color = GoldPrimary, fontSize = 11.sp, fontWeight = FontWeight.Bold)

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text("Dark / Light Mode", color = TextMain, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            Text(if (isDarkTheme) "Currently Luxury Dark" else "Currently Classic Light", color = TextMuted, fontSize = 11.sp)
                        }
                        Switch(
                            checked = isDarkTheme,
                            onCheckedChange = { onToggleTheme() },
                            colors = SwitchDefaults.colors(checkedThumbColor = GoldPrimary)
                        )
                    }

                    HorizontalDivider(color = GoldLineSubtle)

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text("Language (বাংলা / English)", color = TextMain, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            Text("Selected: ${currentLanguage.uppercase()}", color = TextMuted, fontSize = 11.sp)
                        }
                        Button(
                            onClick = onToggleLanguage,
                            colors = ButtonDefaults.buttonColors(containerColor = BgInner),
                            border = androidx.compose.foundation.BorderStroke(1.dp, GoldBorder),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Text(if (currentLanguage == "bn") "English" else "বাংলা", color = GoldPrimary, fontSize = 11.sp)
                        }
                    }
                }
            }
        }

        // Security & Account
        item {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = BgCard),
                border = androidx.compose.foundation.BorderStroke(1.dp, GoldLineSubtle)
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("SECURITY CONTROLS", color = GoldPrimary, fontSize = 11.sp, fontWeight = FontWeight.Bold)

                    Button(
                        onClick = { showChangePassDialog = true },
                        colors = ButtonDefaults.buttonColors(containerColor = BgInner),
                        border = androidx.compose.foundation.BorderStroke(1.dp, GoldLineSubtle),
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.Default.Lock, contentDescription = null, tint = GoldPrimary, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Change Admin Password", color = TextMain, fontSize = 12.sp)
                    }

                    Button(
                        onClick = onLogout,
                        colors = ButtonDefaults.buttonColors(containerColor = AccentRed),
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.fillMaxWidth().testTag("btn_settings_logout")
                    ) {
                        Text("Logout from Admin Console", color = OnGold, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    }
                }
            }
        }
    }

    if (showChangePassDialog) {
        var oldPass by remember { mutableStateOf("") }
        var newPass by remember { mutableStateOf("") }

        AlertDialog(
            onDismissRequest = { showChangePassDialog = false },
            title = { Text("Change Password", color = GoldPrimary, fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = oldPass, onValueChange = { oldPass = it }, label = { Text("Current Password") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = newPass, onValueChange = { newPass = it }, label = { Text("New Secure Password") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        if (oldPass.isNotBlank() && newPass.isNotBlank()) {
                            onChangePassword(oldPass, newPass)
                            showChangePassDialog = false
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary)
                ) {
                    Text("Update", color = OnGold)
                }
            },
            dismissButton = {
                TextButton(onClick = { showChangePassDialog = false }) { Text("Cancel") }
            },
            containerColor = BgSurface
        )
    }
}
